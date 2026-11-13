# Line numa VPS

Um comando instala o servidor do Line com HTTPS (Caddy) e TURN (coturn) numa VPS Ubuntu 22.04/24.04 ou Debian 12, x86 ou ARM (ex.: Oracle Cloud Always Free, Ampere A1).

## Antes

1. Aponte um domínio para o IP público da VPS (um grátis serve, ex.: `line-xande.duckdns.org`).
2. Libere no firewall do provedor (na Oracle: *Security List* da subnet), de qualquer origem (`0.0.0.0/0`):
   - TCP `80`, `443`: site e API com HTTPS
   - TCP e UDP `3478`: TURN
   - UDP `49160-49200`: tráfego de mídia do TURN

## Instalar / atualizar

```bash
curl -fsSLO https://raw.githubusercontent.com/AlehSouza/Line/claude/project-thread-dqswre/deploy/vps/install.sh
sudo bash install.sh line-xande.duckdns.org
```

Rodar de novo atualiza para a versão mais nova. Os dados (banco e anexos) ficam em `/var/lib/line`; para backup, copie essa pasta.

## Usar

- Site com downloads: `https://SEU-DOMINIO` (aba Downloads em `#downloads`, arquivos em `/updates/latest/`).
- Pelo navegador: `https://SEU-DOMINIO/app/` (funciona com chamadas em qualquer sistema, inclusive Linux).
- Pelo app: na tela de login, clique em "alterar" ao lado de Servidor e coloque `https://SEU-DOMINIO`.

## Comandos úteis

```bash
journalctl -u line -f          # logs do servidor
systemctl restart line         # reiniciar
journalctl -u coturn -n 50     # logs do TURN
```
