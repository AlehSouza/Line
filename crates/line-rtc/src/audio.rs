//! Opus de ida e volta. A página manda PCM de 20 ms (48 kHz, mono) e recebe PCM de volta:
//! assim o áudio não depende do WebCodecs nem dos plugins do GStreamer de cada distro.

/// Amostras em 20 ms a 48 kHz: o tamanho de quadro que o WebRTC usa no Opus.
pub const FRAME: usize = 960;
pub const RATE: u32 = 48_000;

pub struct Encoder(opus::Encoder);

impl Encoder {
    pub fn new() -> Result<Self, opus::Error> {
        let mut enc = opus::Encoder::new(RATE, opus::Channels::Mono, opus::Application::Voip)?;
        // Mesmo perfil do Chrome para voz: ~40 kbps, com FEC para aguentar perda de pacote.
        enc.set_bitrate(opus::Bitrate::Bits(40_000))?;
        enc.set_inband_fec(true)?;
        enc.set_packet_loss_perc(10)?;
        Ok(Self(enc))
    }

    /// Um quadro de [`FRAME`] amostras vira um pacote Opus.
    pub fn encode(&mut self, pcm: &[i16]) -> Option<Vec<u8>> {
        if pcm.len() != FRAME {
            return None;
        }
        self.0.encode_vec(pcm, 1500).ok()
    }
}

pub struct Decoder(opus::Decoder);

impl Decoder {
    pub fn new() -> Result<Self, opus::Error> {
        // Mono: se o outro lado mandar estéreo, o próprio Opus mistura.
        Ok(Self(opus::Decoder::new(RATE, opus::Channels::Mono)?))
    }

    pub fn decode(&mut self, packet: &[u8]) -> Option<Vec<i16>> {
        // Até 120 ms por pacote.
        let mut out = vec![0i16; FRAME * 6];
        let n = self.0.decode(packet, &mut out, false).ok()?;
        out.truncate(n);
        Some(out)
    }

    /// Pacote perdido: o Opus inventa 20 ms parecidos com o que vinha (PLC), em vez de um buraco.
    pub fn conceal(&mut self) -> Option<Vec<i16>> {
        let mut out = vec![0i16; FRAME];
        let n = self.0.decode(&[], &mut out, false).ok()?;
        out.truncate(n);
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ida_e_volta() {
        let mut enc = Encoder::new().unwrap();
        let mut dec = Decoder::new().unwrap();
        // 440 Hz por 200 ms.
        let mut energy = 0f64;
        for f in 0..10 {
            let pcm: Vec<i16> = (0..FRAME)
                .map(|i| {
                    let t = (f * FRAME + i) as f64 / RATE as f64;
                    ((t * 440.0 * std::f64::consts::TAU).sin() * 8000.0) as i16
                })
                .collect();
            let packet = enc.encode(&pcm).unwrap();
            assert!(!packet.is_empty() && packet.len() < 400);
            let out = dec.decode(&packet).unwrap();
            assert_eq!(out.len(), FRAME);
            if f > 2 {
                energy += out.iter().map(|&s| (s as f64).powi(2)).sum::<f64>();
            }
        }
        assert!(energy > 0.0);
        assert_eq!(dec.conceal().unwrap().len(), FRAME);
    }
}
