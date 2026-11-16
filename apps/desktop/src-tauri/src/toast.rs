//! Notificações nativas do Windows (toast) com a cara do Line: nome "Line" e ícone do app
//! em vez de "tauri.localhost", foto redonda de quem mandou e caixa de resposta rápida.
//! Os cliques e respostas chegam pelo evento Activated e são entregues à interface.

use std::collections::VecDeque;
use std::sync::Mutex;

use windows::core::{Interface, HSTRING, PCWSTR};
use windows::Data::Xml::Dom::XmlDocument;
use windows::Foundation::{IPropertyValue, TypedEventHandler};
use windows::UI::Notifications::{ToastActivatedEventArgs, ToastNotification, ToastNotificationManager, ToastNotifier};
use windows_core::IInspectable;

/// Mesmo id dos atalhos que o instalador cria (o identificador do app).
pub const AUMID: &str = "app.line.desktop";

/// Os toasts precisam continuar vivos para o clique na Central de Ações ainda chegar até nós.
static ALIVE: Mutex<VecDeque<ToastNotification>> = Mutex::new(VecDeque::new());

fn packaged() -> bool {
    windows::ApplicationModel::Package::Current().is_ok()
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Registra o nome e o ícone que o Windows mostra no topo da notificação. Na versão da Store
/// isso já vem do pacote.
pub fn register(icon_png: &[u8]) {
    if packaged() {
        return;
    }
    use windows::Win32::System::Registry::{RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ};
    use windows::Win32::UI::Shell::SetCurrentProcessExplicitAppUserModelID;
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from(AUMID));
    }
    let dir = std::env::var_os("LOCALAPPDATA").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Line");
    let _ = std::fs::create_dir_all(&dir);
    let icon = dir.join("notificacao.png");
    let _ = std::fs::write(&icon, icon_png);
    let key = wide(&format!("Software\\Classes\\AppUserModelId\\{AUMID}"));
    let set = |name: &str, value: &str| {
        let n = wide(name);
        let v = wide(value);
        unsafe {
            let _ = RegSetKeyValueW(
                HKEY_CURRENT_USER,
                PCWSTR(key.as_ptr()),
                PCWSTR(n.as_ptr()),
                REG_SZ.0,
                Some(v.as_ptr() as *const _),
                (v.len() * 2) as u32,
            );
        }
    };
    set("DisplayName", "Line");
    set("IconUri", &icon.to_string_lossy());
    set("IconBackgroundColor", "FF000000");
}

fn notifier() -> windows::core::Result<ToastNotifier> {
    if packaged() {
        ToastNotificationManager::CreateToastNotifier()
    } else {
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(AUMID))
    }
}

fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

pub struct Toast {
    pub title: String,
    pub body: String,
    /// Agrupa por conversa: uma nova mensagem do mesmo canal troca a anterior.
    pub tag: String,
    /// Volta para a interface no clique/resposta.
    pub data: String,
    /// Caminho de um PNG local com a foto (o Windows não carrega imagens da internet em apps fora da Store).
    pub avatar: Option<std::path::PathBuf>,
    pub reply: bool,
}

/// `on_activate(acao, data, resposta)`: acao é "open" (clicou) ou "reply" (Enviar).
pub fn show<F>(t: Toast, on_activate: F) -> windows::core::Result<()>
where
    F: Fn(&str, &str, Option<String>) + Send + Sync + 'static,
{
    let image = t
        .avatar
        .as_ref()
        .map(|p| format!(r#"<image placement="appLogoOverride" hint-crop="circle" src="{}"/>"#, esc(&p.to_string_lossy())))
        .unwrap_or_default();
    let actions = if t.reply {
        format!(
            r#"<actions><input id="reply" type="text" placeHolderContent="Digite uma resposta"/><action content="Enviar" arguments="reply|{}" hint-inputId="reply" activationType="foreground"/></actions>"#,
            esc(&t.data)
        )
    } else {
        String::new()
    };
    let xml = format!(
        r#"<toast launch="open|{data}" activationType="foreground"><visual><binding template="ToastGeneric"><text hint-maxLines="1">{title}</text><text>{body}</text>{image}</binding></visual>{actions}<audio silent="true"/></toast>"#,
        data = esc(&t.data),
        title = esc(&t.title),
        body = esc(&t.body),
    );
    let doc = XmlDocument::new()?;
    doc.LoadXml(&HSTRING::from(xml))?;
    let toast = ToastNotification::CreateToastNotification(&doc)?;
    let tag: String = t.tag.chars().filter(|c| c.is_ascii_alphanumeric()).take(64).collect();
    if !tag.is_empty() {
        let _ = toast.SetTag(&HSTRING::from(tag));
        let _ = toast.SetGroup(&HSTRING::from("line"));
    }
    toast.Activated(&TypedEventHandler::<ToastNotification, IInspectable>::new(move |_, args| {
        let Some(args) = args.as_ref() else { return Ok(()) };
        let Ok(args) = args.cast::<ToastActivatedEventArgs>() else { return Ok(()) };
        let raw = args.Arguments().map(|a| a.to_string()).unwrap_or_default();
        let (action, data) = raw.split_once('|').unwrap_or(("open", raw.as_str()));
        let reply = args
            .UserInput()
            .ok()
            .and_then(|set| set.Lookup(&HSTRING::from("reply")).ok())
            .and_then(|v| v.cast::<IPropertyValue>().ok())
            .and_then(|v| v.GetString().ok())
            .map(|s| s.to_string());
        on_activate(action, data, reply);
        Ok(())
    }))?;
    notifier()?.Show(&toast)?;
    let mut alive = ALIVE.lock().unwrap_or_else(|e| e.into_inner());
    alive.push_back(toast);
    while alive.len() > 30 {
        alive.pop_front();
    }
    Ok(())
}
