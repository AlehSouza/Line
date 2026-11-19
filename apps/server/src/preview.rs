//! Prévia borrada das imagens, feita no servidor.
//!
//! Mídia coberta (spoiler/conteúdo sensível) mostra só esta prévia: 16 px no maior lado,
//! borrada e guardada como data URL na própria linha do anexo. O app nunca baixa a imagem
//! real enquanto ela está coberta, então não há o que "desborrar".

use base64::Engine;
use std::io::Cursor;
use std::path::Path;

const SIDE: u32 = 16;

/// Tipos que o servidor sabe decodificar (o resto fica sem prévia e o app usa o degradê).
pub fn supported(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/jpeg" | "image/png" | "image/gif" | "image/webp" | "image/bmp"
    )
}

/// Lê a imagem do disco e devolve a prévia (`data:image/png;base64,...`), ou None se não der.
pub fn blurred(path: &Path) -> Option<String> {
    let mut reader = image::ImageReader::open(path).ok()?.with_guessed_format().ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(20_000);
    limits.max_image_height = Some(20_000);
    limits.max_alloc = Some(512 * 1024 * 1024);
    reader.limits(limits);
    let img = reader.decode().ok()?;
    let small = img.thumbnail(SIDE, SIDE).to_rgb8();
    // Borra de novo na miniatura: sobram só manchas de cor.
    let blurred = image::imageops::blur(&small, 1.6);
    let mut out = Vec::new();
    image::DynamicImage::ImageRgb8(blurred)
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

#[cfg(test)]
mod tests {
    #[test]
    fn makes_tiny_blurred_png() {
        let img = image::RgbImage::from_fn(800, 1200, |x, y| image::Rgb([(x % 256) as u8, (y % 256) as u8, 128]));
        let path = std::env::temp_dir().join("line-preview-test.png");
        img.save(&path).unwrap();
        let p = super::blurred(&path).unwrap();
        let _ = std::fs::remove_file(&path);
        assert!(p.starts_with("data:image/png;base64,"));
        assert!(p.len() < 2000, "prévia grande demais: {}", p.len());
    }
}
