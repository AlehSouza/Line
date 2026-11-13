// Sobe a interface local (http://localhost:3000) conversando com o servidor de produção (useline.tech).
// Login, amigos, mensagens, WebSocket e TURN vêm de lá; só a interface é a sua versão local.
// Mudanças no servidor (rotas novas etc.) só aparecem depois do deploy na VPS.
import { spawn } from 'node:child_process';

const url = process.env.NEXT_PUBLIC_SERVER_URL || 'https://useline.tech';
console.log(`\n  Interface local apontando para ${url}\n`);
const child = spawn('npm', ['run', 'dev:web'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NEXT_PUBLIC_SERVER_URL: url },
});
child.on('exit', (code) => process.exit(code ?? 0));
