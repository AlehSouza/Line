//! Áudio da transmissão pelo WASAPI "process loopback" (Windows 10 2004+ / Windows 11).
//!
//! `include = true`: só o som do processo escolhido (e dos filhos), como o app da janela.
//! `include = false`: o som do sistema inteiro menos o processo (o próprio Line).
//! Entrega blocos de ~20ms em float32 intercalado, 48kHz estéreo.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use windows::core::{implement, Interface, IUnknown, Ref, HRESULT};
use windows::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
    AUDCLNT_STREAMFLAGS_LOOPBACK, AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX,
};
use windows::Win32::Media::Multimedia::WAVE_FORMAT_IEEE_FLOAT;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

const RATE: u32 = 48_000;
const CHANNELS: u16 = 2;

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Done(mpsc::Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _: Ref<IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}

pub fn run(
    pid: u32,
    include: bool,
    stop: &AtomicBool,
    mut on_chunk: impl FnMut(&[u8], u64),
) -> Result<(), String> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        let res = capture(pid, include, stop, &mut on_chunk);
        CoUninitialize();
        res.map_err(|e| e.to_string())
    }
}

unsafe fn capture(
    pid: u32,
    include: bool,
    stop: &AtomicBool,
    on_chunk: &mut impl FnMut(&[u8], u64),
) -> windows::core::Result<()> {
    unsafe {
        let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: pid,
                    ProcessLoopbackMode: if include {
                        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                    } else {
                        PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE
                    },
                },
            },
        };
        let prop = PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: &mut params as *mut _ as *mut u8,
                        },
                    },
                }),
            },
        };
        // O PROPVARIANT aponta para `params` na pilha: não pode ser "limpo" no drop.
        let prop = std::mem::ManuallyDrop::new(prop);

        let (tx, rx) = mpsc::channel();
        let handler: IActivateAudioInterfaceCompletionHandler = Done(tx).into();
        let op = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*prop as *const PROPVARIANT),
            &handler,
        )?;
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| windows::core::Error::from(HRESULT(0x8000_000Au32 as i32)))?;
        let mut hr = HRESULT(0);
        let mut unk: Option<IUnknown> = None;
        op.GetActivateResult(&mut hr, &mut unk)?;
        hr.ok()?;
        let client: IAudioClient = unk.ok_or_else(|| windows::core::Error::from(HRESULT(0x8000_4005u32 as i32)))?.cast()?;

        let format = WAVEFORMATEX {
            wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
            nChannels: CHANNELS,
            nSamplesPerSec: RATE,
            nAvgBytesPerSec: RATE * CHANNELS as u32 * 4,
            nBlockAlign: CHANNELS * 4,
            wBitsPerSample: 32,
            cbSize: 0,
        };
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            200_000, // 20ms em unidades de 100ns
            0,
            &format,
            None,
        )?;
        let event = CreateEventW(None, false, false, None)?;
        client.SetEventHandle(event)?;
        let cap: IAudioCaptureClient = client.GetService()?;
        client.Start()?;

        let started = Instant::now();
        let block = format.nBlockAlign as usize;
        let mut chunk: Vec<u8> = Vec::with_capacity(RATE as usize / 50 * block * 2);
        let result = (|| -> windows::core::Result<()> {
            while !stop.load(Ordering::Relaxed) {
                if WaitForSingleObject(event, 100) != WAIT_OBJECT_0 {
                    continue;
                }
                loop {
                    let n = cap.GetNextPacketSize()?;
                    if n == 0 {
                        break;
                    }
                    let mut data = std::ptr::null_mut();
                    let mut frames = 0u32;
                    let mut flags = 0u32;
                    cap.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
                    let bytes = frames as usize * block;
                    if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                        chunk.resize(chunk.len() + bytes, 0);
                    } else {
                        chunk.extend_from_slice(std::slice::from_raw_parts(data, bytes));
                    }
                    cap.ReleaseBuffer(frames)?;
                }
                if chunk.len() >= RATE as usize / 50 * block {
                    let frames = (chunk.len() / block) as u64;
                    let end = started.elapsed().as_micros() as u64;
                    on_chunk(&chunk, end.saturating_sub(frames * 1_000_000 / RATE as u64));
                    chunk.clear();
                }
            }
            Ok(())
        })();
        let _ = client.Stop();
        let _ = CloseHandle(event);
        result
    }
}
