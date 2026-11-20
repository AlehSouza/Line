//! Impede a chamada de abaixar o som dos outros apps no Windows.
//!
//! O Chromium do WebView2 abre o microfone como fluxo de comunicação (AudioCategory_Communications).
//! Com a opção padrão do Windows (Som → Comunicações → "Reduzir o volume de outros sons em 80%"),
//! isso abaixa o som de todo o resto enquanto o Line está na chamada. O Discord evita isso desligando
//! a atenuação padrão na própria sessão de áudio (IAudioSessionControl2::SetDuckingPreference).
//!
//! O áudio do WebView2 roda num processo filho (msedgewebview2.exe), então aqui ficamos de olho nas
//! sessões de áudio de todos os dispositivos e marcamos as que são de processos descendentes do Line.
//! Uma sessão nova dispara o aviso OnSessionCreated, que faz a vigia passar na hora.

use std::collections::{HashMap, HashSet};
use std::sync::mpsc;
use std::time::Duration;

use windows::core::{implement, Interface, Ref, Result};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::Media::Audio::{
    eAll, IAudioSessionControl, IAudioSessionControl2, IAudioSessionManager2, IAudioSessionNotification,
    IAudioSessionNotification_Impl, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};

/// Processos do Line: ele mesmo e todos os descendentes (WebView2, processo de áudio etc.).
fn our_tree() -> HashSet<u32> {
    let me = std::process::id();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    if e.th32ProcessID != e.th32ParentProcessID {
                        children.entry(e.th32ParentProcessID).or_default().push(e.th32ProcessID);
                    }
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
    }
    let mut tree = HashSet::from([me]);
    let mut stack = vec![me];
    while let Some(p) = stack.pop() {
        for &c in children.get(&p).map(Vec::as_slice).unwrap_or(&[]) {
            if tree.insert(c) {
                stack.push(c);
            }
        }
    }
    tree
}

/// Tira a sessão da atenuação padrão do Windows se ela for de um processo do Line.
fn opt_out(session: &IAudioSessionControl, tree: &HashSet<u32>) {
    unsafe {
        let Ok(s2) = session.cast::<IAudioSessionControl2>() else { return };
        let Ok(pid) = s2.GetProcessId() else { return };
        if tree.contains(&pid) {
            let _ = s2.SetDuckingPreference(true);
        }
    }
}

/// Aviso de sessão nova: só acorda a thread (o Windows pede para não mexer em nada dentro do aviso).
#[implement(IAudioSessionNotification)]
struct Created(mpsc::Sender<()>);

impl IAudioSessionNotification_Impl for Created_Impl {
    fn OnSessionCreated(&self, _: Ref<IAudioSessionControl>) -> Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

/// Liga a vigia numa thread própria (fica viva enquanto o Line estiver aberto).
pub fn start() {
    std::thread::spawn(|| unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let Ok(devices) = CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) else {
            return;
        };
        let (wake, woke) = mpsc::channel();
        let notify: IAudioSessionNotification = Created(wake).into();
        // Um gerenciador por dispositivo; precisam continuar vivos para os avisos chegarem.
        let mut managers: HashMap<String, IAudioSessionManager2> = HashMap::new();
        loop {
            let tree = our_tree();
            if let Ok(list) = devices.EnumAudioEndpoints(eAll, DEVICE_STATE_ACTIVE) {
                let count = list.GetCount().unwrap_or(0);
                for i in 0..count {
                    let Ok(device) = list.Item(i) else { continue };
                    let Ok(id) = device.GetId() else { continue };
                    let key = id.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(id.0 as _));
                    if !managers.contains_key(&key) {
                        let Ok(m) = device.Activate::<IAudioSessionManager2>(CLSCTX_ALL, None) else { continue };
                        let _ = m.RegisterSessionNotification(&notify);
                        managers.insert(key.clone(), m);
                    }
                    // Passa pelas sessões que já existem (e o Windows só manda os avisos depois disso).
                    let Some(m) = managers.get(&key) else { continue };
                    let Ok(sessions) = m.GetSessionEnumerator() else { continue };
                    for j in 0..sessions.GetCount().unwrap_or(0) {
                        if let Ok(s) = sessions.GetSession(j) {
                            opt_out(&s, &tree);
                        }
                    }
                }
            }
            // Acorda na hora quando nasce uma sessão (antes do fluxo começar), senão a cada 3 s.
            let _ = woke.recv_timeout(Duration::from_secs(3));
            while woke.try_recv().is_ok() {}
        }
    });
}
