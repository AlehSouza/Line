//! Envio de email (recuperação de senha) por SMTP.
//!
//! Configurado por SMTP_HOST, SMTP_PORT (465 = TLS direto, outra = STARTTLS; padrão 465),
//! SMTP_USER, SMTP_PASS e SMTP_FROM (ex.: "Line <nao-responda@useline.tech>").
//! APP_URL é o endereço do app web usado nos links (padrão https://useline.tech/app).
//! Sem SMTP_HOST, a recuperação de senha fica desativada.
use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

pub struct Mailer {
    transport: AsyncSmtpTransport<Tokio1Executor>,
    from: Mailbox,
    pub app_url: String,
}

impl Mailer {
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let host = var("SMTP_HOST")?;
        let port: u16 = var("SMTP_PORT").and_then(|p| p.parse().ok()).unwrap_or(465);
        let builder = if port == 465 {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&host)
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&host)
        };
        let mut builder = match builder {
            Ok(b) => b.port(port),
            Err(err) => {
                tracing::warn!("SMTP_HOST inválido ({host}): {err}");
                return None;
            }
        };
        if let (Some(user), Some(pass)) = (var("SMTP_USER"), var("SMTP_PASS")) {
            builder = builder.credentials(Credentials::new(user, pass));
        }
        let from_raw = var("SMTP_FROM").or_else(|| var("SMTP_USER"))?;
        let from: Mailbox = match from_raw.parse() {
            Ok(m) => m,
            Err(err) => {
                tracing::warn!("SMTP_FROM inválido ({from_raw}): {err}");
                return None;
            }
        };
        let app_url = var("APP_URL").unwrap_or_else(|| "https://useline.tech/app".into());
        Some(Self {
            transport: builder.build(),
            from,
            app_url: app_url.trim_end_matches('/').to_string(),
        })
    }

    /// Email com o link de redefinição. Erros só vão para o log.
    pub async fn send_password_reset(&self, to: &str, name: &str, link: &str) {
        let Ok(to_box) = to.parse::<Mailbox>() else { return };
        let text = format!(
            "Oi, {name}!\n\nAlguém (talvez você) pediu para redefinir a senha da sua conta no Line.\n\
             Para escolher uma senha nova, abra o link abaixo. Ele vale por 30 minutos e só funciona uma vez.\n\n\
             {link}\n\nSe não foi você, é só ignorar este email: sua senha continua a mesma.\n"
        );
        let html = format!(
            r#"<div style="font-family:system-ui,sans-serif;background:#0f0f12;color:#e6e6ea;padding:32px">
<div style="max-width:440px;margin:0 auto;background:#18181c;border:1px solid #2a2a31;border-radius:16px;padding:28px">
<h2 style="margin:0 0 12px;color:#fff">Redefinir sua senha</h2>
<p>Oi, {name}! Alguém (talvez você) pediu para redefinir a senha da sua conta no Line.</p>
<p style="text-align:center;margin:28px 0"><a href="{link}" style="background:#7c6af2;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600">Escolher nova senha</a></p>
<p style="color:#9a9aa5;font-size:13px">O link vale por 30 minutos e só funciona uma vez. Se não foi você, é só ignorar este email: sua senha continua a mesma.</p>
</div></div>"#,
            name = html_escape(name),
        );
        let msg = Message::builder()
            .from(self.from.clone())
            .to(to_box)
            .subject("Redefinir sua senha do Line")
            .multipart(MultiPart::alternative_plain_html(text, html));
        let msg = match msg {
            Ok(m) => m,
            Err(err) => return tracing::warn!("email de recuperação inválido: {err}"),
        };
        if let Err(err) = self.transport.send(msg).await {
            tracing::warn!("falha ao enviar email de recuperação: {err}");
        }
    }
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}
