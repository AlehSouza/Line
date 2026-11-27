//! Apertar para falar global no Windows: a tecla funciona com o Line em segundo plano (jogo, outro app).
//!
//! Um gancho de teclado de baixo nível (WH_KEYBOARD_LL) vê as teclas do sistema inteiro. Ele só
//! compara com a tecla escolhida e nunca segura nada: a tecla continua chegando ao jogo normalmente.
//! A comparação é pela tecla física (scan code), igual ao `KeyboardEvent.code` que a interface grava,
//! então não depende do layout (ABNT2, US etc.). Nada além de "apertou"/"soltou" sai daqui.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};

use tauri::Manager;
use windows::Win32::Foundation::{LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, KBDLLHOOKSTRUCT, LLKHF_EXTENDED,
    LLKHF_INJECTED, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

/// Tecla escolhida: scan code com o bit 0x100 quando é estendida (setas, Ctrl/Alt da direita...). 0 = desligado.
static TARGET: AtomicU32 = AtomicU32::new(0);
static DOWN: AtomicBool = AtomicBool::new(false);
static EVENTS: OnceLock<Mutex<mpsc::Sender<bool>>> = OnceLock::new();

/// Liga (com o `KeyboardEvent.code` da tecla) ou desliga (None) o Apertar para falar global.
/// Devolve se a tecla é suportada; se não for, a interface continua só com a janela em foco.
#[tauri::command]
pub fn ptt_set(app: tauri::AppHandle, code: Option<String>) -> bool {
    let target = code.as_deref().and_then(scan_code).unwrap_or(0);
    let old = TARGET.swap(target, Ordering::SeqCst);
    if old != target && DOWN.swap(false, Ordering::SeqCst) {
        send(false);
    }
    if target != 0 {
        start(app);
    }
    target != 0
}

fn send(down: bool) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.lock().map(|tx| tx.send(down));
    }
}

/// Sobe o gancho (uma vez só) e a thread que avisa a interface.
fn start(app: tauri::AppHandle) {
    if EVENTS.get().is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<bool>();
    if EVENTS.set(Mutex::new(tx)).is_err() {
        return;
    }
    // O gancho precisa responder rápido (senão o Windows o desliga), então o aviso vai por outra thread.
    std::thread::spawn(move || {
        for down in rx {
            if let Some(w) = app.get_webview_window(crate::MAIN) {
                let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('line:ptt',{{detail:{down}}}))"));
            }
        }
    });
    std::thread::spawn(|| unsafe {
        let Ok(_hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) else {
            tracing::warn!("apertar para falar: não deu para instalar o gancho de teclado");
            return;
        };
        // O gancho só recebe as teclas enquanto esta thread processa mensagens.
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

unsafe extern "system" fn hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let target = TARGET.load(Ordering::Relaxed);
    if code >= 0 && target != 0 {
        // SAFETY: com WH_KEYBOARD_LL e code >= 0, lparam aponta para um KBDLLHOOKSTRUCT válido.
        let k = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        // Teclas simuladas por programas (macros, o próprio Windows) ficam de fora.
        let injected = k.flags.0 & LLKHF_INJECTED.0 != 0;
        let key = k.scanCode | if k.flags.0 & LLKHF_EXTENDED.0 != 0 { 0x100 } else { 0 };
        if !injected && key == target {
            match wparam.0 as u32 {
                WM_KEYDOWN | WM_SYSKEYDOWN => {
                    if !DOWN.swap(true, Ordering::SeqCst) {
                        send(true);
                    }
                }
                WM_KEYUP | WM_SYSKEYUP => {
                    if DOWN.swap(false, Ordering::SeqCst) {
                        send(false);
                    }
                }
                _ => {}
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

/// `KeyboardEvent.code` → scan code (conjunto 1), com 0x100 nas teclas estendidas.
fn scan_code(code: &str) -> Option<u32> {
    let ext = |s: u32| s | 0x100;
    let letters = "QWERTYUIOP\0\0\0\0ASDFGHJKL\0\0\0\0\0ZXCVBNM";
    if let Some(c) = code.strip_prefix("Key").filter(|c| c.len() == 1) {
        let i = letters.find(c)? as u32;
        return Some(0x10 + i);
    }
    if let Some(d) = code.strip_prefix("Digit").and_then(|d| d.parse::<u32>().ok()) {
        return Some(if d == 0 { 0x0B } else { 0x01 + d });
    }
    if let Some(n) = code.strip_prefix('F').and_then(|n| n.parse::<u32>().ok()) {
        return Some(match n {
            1..=10 => 0x3A + n,
            11 => 0x57,
            12 => 0x58,
            13..=23 => 0x64 + (n - 13),
            24 => 0x76,
            _ => return None,
        });
    }
    Some(match code {
        "Escape" => 0x01,
        "Minus" => 0x0C,
        "Equal" => 0x0D,
        "Backspace" => 0x0E,
        "Tab" => 0x0F,
        "BracketLeft" => 0x1A,
        "BracketRight" => 0x1B,
        "Enter" => 0x1C,
        "ControlLeft" => 0x1D,
        "Semicolon" => 0x27,
        "Quote" => 0x28,
        "Backquote" => 0x29,
        "ShiftLeft" => 0x2A,
        "Backslash" => 0x2B,
        "Comma" => 0x33,
        "Period" => 0x34,
        "Slash" => 0x35,
        "ShiftRight" => 0x36,
        "NumpadMultiply" => 0x37,
        "AltLeft" => 0x38,
        "Space" => 0x39,
        "CapsLock" => 0x3A,
        "ScrollLock" => 0x46,
        "Numpad7" => 0x47,
        "Numpad8" => 0x48,
        "Numpad9" => 0x49,
        "NumpadSubtract" => 0x4A,
        "Numpad4" => 0x4B,
        "Numpad5" => 0x4C,
        "Numpad6" => 0x4D,
        "NumpadAdd" => 0x4E,
        "Numpad1" => 0x4F,
        "Numpad2" => 0x50,
        "Numpad3" => 0x51,
        "Numpad0" => 0x52,
        "NumpadDecimal" => 0x53,
        "IntlBackslash" => 0x56,
        "IntlRo" => 0x73,
        "NumpadComma" => 0x7E,
        "NumpadEnter" => ext(0x1C),
        "ControlRight" => ext(0x1D),
        "NumpadDivide" => ext(0x35),
        "PrintScreen" => ext(0x37),
        "AltRight" => ext(0x38),
        "NumLock" => ext(0x45),
        "Home" => ext(0x47),
        "ArrowUp" => ext(0x48),
        "PageUp" => ext(0x49),
        "ArrowLeft" => ext(0x4B),
        "ArrowRight" => ext(0x4D),
        "End" => ext(0x4F),
        "ArrowDown" => ext(0x50),
        "PageDown" => ext(0x51),
        "Insert" => ext(0x52),
        "Delete" => ext(0x53),
        "MetaLeft" => ext(0x5B),
        "MetaRight" => ext(0x5C),
        "ContextMenu" => ext(0x5D),
        _ => return None,
    })
}
