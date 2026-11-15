//! Descobre o jogo aberto (só Windows) para o painel sugerir "Transmitir agora".
//!
//! Passa pelas janelas de primeiro nível e olha o executável de cada uma:
//! 1. executáveis conhecidos (League, VALORANT, Genshin, CS2...);
//! 2. qualquer coisa instalada em pastas de jogos (Steam, Epic, Riot, Xbox, GOG, Ubisoft, EA);
//! 3. a janela em primeiro plano ocupando a tela inteira, se não for navegador, player etc.
//!
//! O id devolvido é o mesmo do seletor de tela ("window:<hwnd>"), então dá para transmitir direto.

#![allow(unsafe_op_in_unsafe_fn)]

use std::collections::HashMap;
use std::sync::Mutex;

use base64::Engine;
use serde::Serialize;
use windows::core::{BOOL, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetMonitorInfoW, GetObjectW, MonitorFromWindow, BITMAP,
    BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ, MONITORINFO, MONITOR_DEFAULTTONEAREST,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Shell::SHDefExtractIconW;
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, GetForegroundWindow, GetIconInfo, GetWindow, GetWindowRect, GetWindowTextLengthW,
    GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible, GW_OWNER, HICON, ICONINFO,
};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    name: String,
    /// Mesmo formato do seletor de tela: "window:<hwnd>".
    window_id: String,
    /// Ícone do executável (PNG em data URL); vazio se não deu para extrair.
    icon: String,
}

/// Executáveis conhecidos → nome bonito (minúsculas).
const KNOWN: &[(&str, &str)] = &[
    ("league of legends.exe", "League of Legends"),
    ("leagueclientux.exe", "League of Legends"),
    ("valorant-win64-shipping.exe", "VALORANT"),
    ("cs2.exe", "Counter-Strike 2"),
    ("csgo.exe", "Counter-Strike"),
    ("dota2.exe", "Dota 2"),
    ("genshinimpact.exe", "Genshin Impact"),
    ("yuanshen.exe", "Genshin Impact"),
    ("starrail.exe", "Honkai: Star Rail"),
    ("zenlesszonezero.exe", "Zenless Zone Zero"),
    ("fortniteclient-win64-shipping.exe", "Fortnite"),
    ("robloxplayerbeta.exe", "Roblox"),
    ("minecraft.windows.exe", "Minecraft"),
    ("gta5.exe", "Grand Theft Auto V"),
    ("gta5_enhanced.exe", "Grand Theft Auto V"),
    ("rdr2.exe", "Red Dead Redemption 2"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("overwatch.exe", "Overwatch 2"),
    ("rocketleague.exe", "Rocket League"),
    ("tslgame.exe", "PUBG: BATTLEGROUNDS"),
    ("wow.exe", "World of Warcraft"),
    ("destiny2.exe", "Destiny 2"),
    ("marvel-win64-shipping.exe", "Marvel Rivals"),
    ("rainbowsix.exe", "Rainbow Six Siege"),
    ("eldenring.exe", "ELDEN RING"),
    ("cyberpunk2077.exe", "Cyberpunk 2077"),
    ("witcher3.exe", "The Witcher 3"),
    ("deadbydaylight-win64-shipping.exe", "Dead by Daylight"),
    ("palworld-win64-shipping.exe", "Palworld"),
    ("helldivers2.exe", "HELLDIVERS 2"),
    ("rustclient.exe", "Rust"),
    ("terraria.exe", "Terraria"),
    ("stardew valley.exe", "Stardew Valley"),
    ("among us.exe", "Among Us"),
    ("lethal company.exe", "Lethal Company"),
    ("phasmophobia.exe", "Phasmophobia"),
    ("osu!.exe", "osu!"),
    ("brawlhalla.exe", "Brawlhalla"),
    ("pathofexile_x64.exe", "Path of Exile"),
    ("pathofexile_x64steam.exe", "Path of Exile"),
    ("left4dead2.exe", "Left 4 Dead 2"),
    ("fallguys_client_game.exe", "Fall Guys"),
];

/// Pastas onde as lojas instalam jogos.
const GAME_DIRS: &[&str] = &[
    "\\steamapps\\common\\",
    "\\epic games\\",
    "\\riot games\\",
    "\\xboxgames\\",
    "\\gog games\\",
    "\\gog galaxy\\games\\",
    "\\ubisoft game launcher\\games\\",
    "\\ea games\\",
    "\\hoyoplay\\games\\",
];

/// Launchers e ajudantes que moram nessas pastas mas não são o jogo.
const NOT_GAME_PATHS: &[&str] = &["\\epic games\\launcher\\", "\\riot client\\", "\\riotclient"];
const NOT_GAME_WORDS: &[&str] = &["launcher", "crashhandler", "crashreport", "crashpad", "anticheat", "helper", "updater", "setup", "installer", "redist"];

/// Programas que ficam em tela cheia sem ser jogo.
const NOT_FULLSCREEN: &[&str] = &[
    "chrome.exe", "msedge.exe", "firefox.exe", "opera.exe", "brave.exe", "vivaldi.exe", "iexplore.exe", "arc.exe",
    "explorer.exe", "applicationframehost.exe", "searchhost.exe", "startmenuexperiencehost.exe",
    "shellexperiencehost.exe", "lockapp.exe", "textinputhost.exe", "msedgewebview2.exe", "wwahost.exe",
    "vlc.exe", "mpc-hc64.exe", "mpc-hc.exe", "mpc-be64.exe", "potplayermini64.exe", "potplayermini.exe", "mpv.exe",
    "wmplayer.exe", "video.ui.exe", "microsoft.media.player.exe", "photos.exe", "stremio.exe",
    "powerpnt.exe", "winword.exe", "excel.exe", "acrobat.exe", "acrord32.exe", "photoshop.exe",
    "obs64.exe", "discord.exe", "spotify.exe", "code.exe", "devenv.exe", "windowsterminal.exe", "mstsc.exe",
    "teams.exe", "ms-teams.exe", "zoom.exe", "steam.exe", "steamwebhelper.exe", "line.exe",
];

/// Último jogo achado só por estar em tela cheia: continua valendo enquanto a janela existir
/// (senão sumiria ao clicar no Line).
static STICKY: Mutex<Option<(usize, String, String)>> = Mutex::new(None);
/// Ícones já extraídos, por executável.
static ICONS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

#[tauri::command]
pub async fn game_running() -> Option<Game> {
    tauri::async_runtime::spawn_blocking(detect).await.ok().flatten()
}

struct Win {
    hwnd: HWND,
    pid: u32,
    title: String,
}

unsafe extern "system" fn collect(hwnd: HWND, lp: LPARAM) -> BOOL {
    unsafe {
        let list = &mut *(lp.0 as *mut Vec<Win>);
        // Só janelas de primeiro nível, visíveis e com título (minimizadas valem: jogo em tela
        // cheia exclusiva minimiza ao trocar de janela).
        if IsWindowVisible(hwnd).as_bool() && GetWindow(hwnd, GW_OWNER).map_or(true, |o| o.0.is_null()) {
            let len = GetWindowTextLengthW(hwnd);
            if len > 0 {
                let mut buf = vec![0u16; len as usize + 1];
                let n = GetWindowTextW(hwnd, &mut buf);
                let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if !title.trim().is_empty() && pid != 0 {
                    list.push(Win { hwnd, pid, title });
                }
            }
        }
        BOOL(1)
    }
}

fn exe_path(pid: u32) -> Option<String> {
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = vec![0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(h);
        ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
    }
}

fn file_name(path: &str) -> String {
    path.rsplit('\\').next().unwrap_or(path).to_lowercase()
}

/// Janela cobrindo o monitor inteiro (tela cheia ou janela sem bordas).
fn covers_monitor(hwnd: HWND) -> bool {
    unsafe {
        if IsIconic(hwnd).as_bool() {
            return false;
        }
        let mut r = RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return false;
        }
        let mon = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !GetMonitorInfoW(mon, &mut info).as_bool() {
            return false;
        }
        let m = info.rcMonitor;
        r.left <= m.left && r.top <= m.top && r.right >= m.right && r.bottom >= m.bottom
    }
}

/// Nome da pasta do jogo dentro da pasta da loja (quando a janela não tem um título bom).
fn folder_name(lower: &str, path: &str) -> Option<String> {
    let dir = GAME_DIRS.iter().find(|d| lower.contains(*d))?;
    let start = lower.find(dir)? + dir.len();
    path.get(start..)?.split('\\').next().filter(|s| !s.is_empty()).map(str::to_string)
}

fn detect() -> Option<Game> {
    let mut list: Vec<Win> = Vec::new();
    unsafe {
        let _ = EnumWindows(Some(collect), LPARAM(&mut list as *mut _ as isize));
    }
    let me = std::process::id();
    let fg = unsafe { GetForegroundWindow() };
    let mut exes: HashMap<u32, Option<String>> = HashMap::new();

    // (prioridade, janela em primeiro plano, hwnd, nome, executável)
    let mut best: Option<(u8, bool, HWND, String, String)> = None;
    for w in &list {
        if w.pid == me {
            continue;
        }
        let Some(path) = exes.entry(w.pid).or_insert_with(|| exe_path(w.pid)).clone() else { continue };
        let lower = path.to_lowercase();
        let file = file_name(&path);
        let title = w.title.trim().to_string();
        let found = if let Some((_, name)) = KNOWN.iter().find(|(e, _)| *e == file) {
            Some((3, name.to_string()))
        } else if file == "javaw.exe" && title.starts_with("Minecraft") {
            Some((3, "Minecraft".to_string()))
        } else if GAME_DIRS.iter().any(|d| lower.contains(d))
            && !NOT_GAME_PATHS.iter().any(|d| lower.contains(d))
            && !NOT_GAME_WORDS.iter().any(|k| file.contains(k))
        {
            let name = if title.len() >= 2 { title.clone() } else { folder_name(&lower, &path).unwrap_or(title.clone()) };
            Some((2, name))
        } else if w.hwnd == fg && !NOT_FULLSCREEN.contains(&file.as_str()) && covers_monitor(w.hwnd) {
            Some((1, title.clone()))
        } else {
            None
        };
        let Some((prio, name)) = found else { continue };
        let front = w.hwnd == fg;
        let better = match &best {
            None => true,
            Some((p, f, ..)) => (prio, front) > (*p, *f),
        };
        if better {
            best = Some((prio, front, w.hwnd, name, path));
        }
    }

    let mut sticky = STICKY.lock().ok()?;
    let (hwnd, name, path) = match best {
        Some((prio, _, hwnd, name, path)) => {
            if prio == 1 {
                *sticky = Some((hwnd.0 as usize, name.clone(), path.clone()));
            }
            (hwnd.0 as usize, name, path)
        }
        None => {
            let (h, name, path) = sticky.clone()?;
            if !unsafe { IsWindow(Some(HWND(h as *mut _))) }.as_bool() {
                *sticky = None;
                return None;
            }
            (h, name, path)
        }
    };
    drop(sticky);
    Some(Game { name, window_id: format!("window:{hwnd}"), icon: icon_for(&path) })
}

fn icon_for(path: &str) -> String {
    let mut cache = match ICONS.lock() {
        Ok(c) => c,
        Err(_) => return String::new(),
    };
    let map = cache.get_or_insert_with(HashMap::new);
    if let Some(i) = map.get(path) {
        return i.clone();
    }
    let icon = extract_icon(path).unwrap_or_default();
    map.insert(path.to_string(), icon.clone());
    icon
}

/// Ícone do executável em 64px, como PNG.
fn extract_icon(path: &str) -> Option<String> {
    unsafe {
        let wide: Vec<u16> = path.encode_utf16().chain(std::iter::once(0)).collect();
        let mut hicon = HICON::default();
        SHDefExtractIconW(PCWSTR(wide.as_ptr()), 0, 0, Some(&mut hicon), None, 64).ok().ok()?;
        if hicon.is_invalid() {
            return None;
        }
        let out = icon_png(hicon);
        let _ = DestroyIcon(hicon);
        out
    }
}

unsafe fn icon_png(hicon: HICON) -> Option<String> {
    let mut ii = ICONINFO::default();
    GetIconInfo(hicon, &mut ii).ok()?;
    let color = ii.hbmColor;
    let mask = ii.hbmMask;
    let res = (|| {
        if color.is_invalid() {
            return None;
        }
        let mut bm = BITMAP::default();
        if GetObjectW(HGDIOBJ(color.0), std::mem::size_of::<BITMAP>() as i32, Some(&mut bm as *mut _ as *mut _)) == 0 {
            return None;
        }
        let (w, h) = (bm.bmWidth, bm.bmHeight);
        if w <= 0 || h <= 0 || w > 512 || h > 512 {
            return None;
        }
        let mut bi = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut px = vec![0u8; (w * h * 4) as usize];
        let dc = CreateCompatibleDC(None);
        let lines = GetDIBits(dc, color, 0, h as u32, Some(px.as_mut_ptr() as *mut _), &mut bi, DIB_RGB_COLORS);
        let _ = DeleteDC(dc);
        if lines == 0 {
            return None;
        }
        // BGRA → RGBA. Ícones antigos vêm sem alfa: aí fica tudo opaco.
        let has_alpha = px.chunks_exact(4).any(|p| p[3] != 0);
        for p in px.chunks_exact_mut(4) {
            p.swap(0, 2);
            if !has_alpha {
                p[3] = 255;
            }
        }
        let img = image::RgbaImage::from_raw(w as u32, h as u32, px)?;
        let mut png = Vec::new();
        image::DynamicImage::ImageRgba8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .ok()?;
        Some(format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(png)))
    })();
    if !color.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(color.0));
    }
    if !mask.is_invalid() {
        let _ = DeleteObject(HGDIOBJ(mask.0));
    }
    res
}
