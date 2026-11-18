// Painel administrador do Line (backoffice.useline.tech). Sem build: JavaScript puro.
// O Caddy deste subdomínio repassa só /api/admin/* para o servidor do Line, que responde
// apenas para as contas admin.
'use strict';

const TOKEN_KEY = 'line.admin.token';
const $ = (sel) => document.querySelector(sel);
/** Arquivos (fotos, prints) ficam no domínio principal (/api/attachments/...). */
const FILES = location.hostname.startsWith('backoffice.') ? `${location.protocol}//${location.host.slice(11)}` : '';

// ---------- utilidades ----------

/** Cria um elemento. Filhos em texto viram nós de texto (nada de innerHTML com dados). */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const nf = new Intl.NumberFormat('pt-BR');
const num = (n) => nf.format(n || 0);
function bytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`;
}
function date(iso, withTime = true) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (d.getFullYear() >= 9999) return 'para sempre';
  return d.toLocaleString('pt-BR', withTime ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' });
}
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'agora';
  if (s < 3600) return `há ${Math.floor(s / 60)} min`;
  if (s < 86400) return `há ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `há ${Math.floor(s / 86400)} d`;
  return date(iso, false);
}
const banned = (until) => !!until && new Date(until).getTime() > Date.now();
function initials(name) {
  return (name || '?')
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0] || '')
    .join('')
    .toUpperCase();
}
/** Ícone padrão (logo do Line acinzentado), igual ao do app para quem não tem foto. */
function defaultIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 32 32');
  const rect = document.createElementNS(ns, 'rect');
  rect.setAttribute('width', '32');
  rect.setAttribute('height', '32');
  rect.setAttribute('fill', '#4a4a54');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M8 19c3-6 6-6 8-3s5 3 8-3');
  path.setAttribute('stroke', '#d6d6de');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('fill', 'none');
  const dot = document.createElementNS(ns, 'circle');
  dot.setAttribute('cx', '24');
  dot.setAttribute('cy', '10');
  dot.setAttribute('r', '2.4');
  dot.setAttribute('fill', '#d6d6de');
  dot.setAttribute('opacity', '0.7');
  svg.append(rect, path, dot);
  return svg;
}

/** Foto (do domínio principal) ou o ícone padrão do Line. */
function avatar(name, url, square = false) {
  const el = h('span', { class: square ? 'av sq' : 'av', title: name || '' });
  if (url) {
    const img = h('img', { src: `${FILES}${url}`, alt: '', loading: 'lazy' });
    img.addEventListener('error', () => img.replaceWith(defaultIcon()));
    el.append(img);
  } else el.append(defaultIcon());
  return el;
}
function who(u, sub) {
  return h('div', { class: 'who' }, avatar(u.displayName || u.username, u.avatarUrl), h('div', {}, h('b', {}, u.displayName || u.username || '—'), h('span', {}, sub ?? `@${u.username || '?'}`)));
}

let toastTimer;
function toast(text, err = false) {
  const t = $('#toast');
  t.textContent = text;
  t.className = err ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}

/** Confirmação no estilo do Line (sem confirm() do navegador). Devolve os valores dos campos ou null. */
function ask({ title, message, confirm = 'Confirmar', danger = false, fields = [] }) {
  return new Promise((resolve) => {
    const box = $('#dialog');
    const inputs = fields.map((f) =>
      f.options
        ? h('select', { name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: o.value === f.value }, o.label)))
        : f.multiline
          ? h('textarea', { name: f.name, rows: 3, placeholder: f.placeholder || '', maxlength: 1000 })
          : h('input', { name: f.name, placeholder: f.placeholder || '', value: f.value || '' }),
    );
    const done = (ok) => {
      box.hidden = true;
      box.replaceChildren();
      document.removeEventListener('keydown', onKey);
      resolve(ok ? Object.fromEntries(inputs.map((i) => [i.name, i.value])) : null);
    };
    const onKey = (e) => e.key === 'Escape' && done(false);
    document.addEventListener('keydown', onKey);
    const card = h(
      'div',
      { class: 'dialog-card' },
      h('h3', {}, title),
      message && h('p', { class: 'muted', style: 'margin:0' }, message),
      fields.map((f, i) => h('label', {}, f.label, inputs[i])),
      h(
        'div',
        { class: 'buttons' },
        h('button', { class: 'btn ghost', onclick: () => done(false) }, 'Cancelar'),
        h('button', { class: danger ? 'btn danger solid' : 'btn primary', onclick: () => done(true) }, confirm),
      ),
    );
    box.replaceChildren(card);
    box.onmousedown = (e) => e.target === box && done(false);
    box.hidden = false;
    (inputs[0] || card.querySelector('.btn.primary, .btn.solid'))?.focus();
  });
}

// ---------- API ----------

let token = null;
try {
  token = localStorage.getItem(TOKEN_KEY);
} catch {
  /* sem localStorage */
}

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* resposta sem JSON */
  }
  if (res.status === 401) {
    toLogin('Sua sessão expirou. Entre de novo.');
    throw new Error('Sessão expirada');
  }
  if (res.status === 403 && path === '/admin/me') {
    location.replace('https://useline.tech/app/');
    throw new Error('Acesso restrito');
  }
  if (!res.ok) throw new Error(data?.message || `Erro ${res.status}`);
  return data;
}

/** Roda uma ação; erro vira aviso no topo. */
async function act(fn, done) {
  try {
    await fn();
    if (done) toast(done);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

// ---------- sessão ----------
// A tela de login é login.html: o servidor só entrega esta página para quem é admin
// (cookie conferido pelo Caddy em /api/admin/gate).

function toLogin(message = '') {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ok */
  }
  location.replace(`/login.html${message ? `?msg=${encodeURIComponent(message)}` : ''}`);
}

$('#logout').addEventListener('click', async () => {
  await fetch('/api/admin/logout', { method: 'POST' }).catch(() => {});
  toLogin();
});

let isOwner = false;

async function boot() {
  if (!token) return toLogin();
  try {
    const me = await api('GET', '/admin/me');
    $('#me').textContent = `@${me.username}`;
    isOwner = !!me.owner;
  } catch (e) {
    return toLogin(e.message === 'Sessão expirada' ? '' : e.message);
  }
  $('#shell').hidden = false;
  route();
}

// ---------- navegação ----------

const pages = { overview, users, servers, reports: () => reportsPage('reports'), feedback: () => reportsPage('feedback'), admins, log };

function route() {
  const page = location.hash.slice(1) || 'overview';
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.dataset.page === page);
  closeDrawer();
  (pages[page] || overview)();
}
window.addEventListener('hashchange', route);
for (const a of document.querySelectorAll('#nav a')) a.addEventListener('click', () => (location.hash = a.dataset.page));

function render(...nodes) {
  $('#main').replaceChildren(...nodes);
}
function loading() {
  render(h('p', { class: 'muted' }, 'Carregando…'));
}

// ---------- visão geral ----------

function tile(label, value, sub) {
  return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), sub && h('div', { class: 'sub' }, sub));
}

/** Gráfico de barras dos últimos 30 dias (SVG). */
function chart(series) {
  const W = 600;
  const H = 120;
  const pad = 16;
  const max = Math.max(1, ...series.map((d) => d.count));
  const bw = W / series.length;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('class', 'chart');
  series.forEach((d, i) => {
    const bh = Math.max(d.count ? 2 : 0, ((H - pad) * d.count) / max);
    const r = document.createElementNS(ns, 'rect');
    r.setAttribute('x', String(i * bw + 1));
    r.setAttribute('y', String(H - pad - bh));
    r.setAttribute('width', String(Math.max(1, bw - 2)));
    r.setAttribute('height', String(bh));
    r.setAttribute('rx', '2');
    const t = document.createElementNS(ns, 'title');
    const [y, m, dd] = d.date.split('-');
    t.textContent = `${dd}/${m}/${y}: ${num(d.count)}`;
    r.append(t);
    svg.append(r);
  });
  for (const i of [0, series.length - 1]) {
    const t = document.createElementNS(ns, 'text');
    const [, m, dd] = series[i].date.split('-');
    t.textContent = `${dd}/${m}`;
    t.setAttribute('x', String(i === 0 ? 0 : W));
    t.setAttribute('y', String(H - 2));
    t.setAttribute('text-anchor', i === 0 ? 'start' : 'end');
    t.setAttribute('class', 'axis');
    svg.append(t);
  }
  return svg;
}

function chartCard(title, series) {
  const total = series.reduce((a, d) => a + d.count, 0);
  return h('div', { class: 'card' }, h('h3', {}, title, h('span', {}, `${num(total)} em 30 dias`)), chart(series));
}

async function overview() {
  loading();
  let s;
  try {
    s = await api('GET', '/admin/stats');
  } catch (e) {
    return render(h('p', { class: 'error' }, e.message));
  }
  setBadges(s.reports.open, s.reports.feedbackOpen);
  const live = s.liveCalls.length
    ? s.liveCalls.map((c) =>
        h(
          'div',
          { class: 'row' },
          h('div', {}, h('b', {}, c.serverName ? `${c.serverName} · ${c.channelName || 'voz'}` : 'Chamada privada'), h('div', { class: 'muted small' }, c.users.map((u) => u.displayName).join(', '))),
          h('span', { class: 'pill green' }, `${c.users.length} na chamada`),
        ),
      )
    : [h('p', { class: 'muted' }, 'Ninguém em chamada agora.')];
  render(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Visão geral'), h('span', { class: 'muted' }, `Servidor v${s.version} · atualizado ${new Date().toLocaleTimeString('pt-BR')}`)), h('button', { class: 'btn', onclick: overview }, 'Atualizar')),
    h(
      'div',
      { class: 'tiles' },
      tile('Membros', num(s.users.total), h('span', {}, h('b', {}, `+${num(s.users.today)}`), ` hoje · +${num(s.users.week)} na semana`)),
      tile('Online agora', num(s.online), `${num(s.inCall)} em chamada`),
      tile('Ativos (7 dias)', num(s.users.activeWeek), 'mandaram mensagem'),
      tile('Servidores', num(s.servers.total), `${num(s.servers.public)} públicos · +${num(s.servers.week)} na semana`),
      tile('Mensagens', num(s.messages.total), `${num(s.messages.today)} nas últimas 24 h`),
      tile('Chamadas', num(s.calls.total), `${num(s.calls.today)} nas últimas 24 h`),
      tile('Bot de música', num(s.music.total), `${num(s.musicPlaying)} tocando agora · ${num(s.music.servers)} servidores`),
      tile('Anexos', num(s.attachments.total), bytes(s.attachments.bytes)),
      tile('Denúncias abertas', num(s.reports.open), h('a', { href: '#reports' }, 'ver denúncias')),
      tile('Bugs e melhorias', num(s.reports.feedbackOpen), h('a', { href: '#feedback' }, 'ver relatos')),
      tile('Suspensos', num(s.users.banned), `${num(s.users.google)} contas com Google`),
    ),
    h('h2', {}, 'Últimos 30 dias'),
    h('div', { class: 'grid2' }, chartCard('Membros novos por dia', s.series.signups), chartCard('Mensagens por dia', s.series.messages), chartCard('Entradas em chamadas por dia', s.series.calls), chartCard('Músicas pedidas por dia', s.series.music)),
    h('h2', {}, 'Agora'),
    h(
      'div',
      { class: 'grid2' },
      h('div', { class: 'card' }, h('h3', {}, 'Chamadas ao vivo'), ...live),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Membros mais novos'),
        ...s.recentUsers.map((u) => h('div', { class: 'row click', style: 'cursor:pointer', onclick: () => openUser(u.id) }, who(u), h('span', { class: 'muted small' }, ago(u.createdAt)))),
      ),
      h(
        'div',
        { class: 'card' },
        h('h3', {}, 'Servidores mais ativos', h('span', {}, 'mensagens na semana')),
        ...(s.topServers.length ? s.topServers.map((sv) => h('div', { class: 'row', style: 'cursor:pointer', onclick: () => openServer(sv.id) }, h('div', {}, h('b', {}, sv.name), h('div', { class: 'muted small' }, `${num(sv.memberCount)} membros`)), h('span', { class: 'pill violet' }, num(sv.messagesWeek)))) : [h('p', { class: 'muted' }, 'Nenhum servidor ainda.')]),
      ),
    ),
  );
}

function setBadges(reports, feedback) {
  $('#badge-reports').textContent = reports ? String(reports) : '';
  $('#badge-feedback').textContent = feedback ? String(feedback) : '';
}

// ---------- listas com busca e "carregar mais" ----------

function listPage({ title, subtitle, tabs, initialTab, placeholder, load, head, row, onRow }) {
  let q = '';
  let tab = initialTab;
  let offset = 0;
  const body = h('tbody');
  const more = h('button', { class: 'btn', onclick: () => fetchPage(false) }, 'Carregar mais');
  const empty = h('div', { class: 'empty', hidden: true }, 'Nada encontrado.');
  let timer;
  const search = h('input', {
    placeholder,
    oninput: (e) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        q = e.target.value;
        fetchPage(true);
      }, 250);
    },
  });
  const tabBar =
    tabs &&
    h(
      'div',
      { class: 'tabs' },
      tabs.map((t) =>
        h(
          'button',
          {
            class: t.id === tab ? 'on' : '',
            onclick: (e) => {
              tab = t.id;
              for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target);
              fetchPage(true);
            },
          },
          t.label,
        ),
      ),
    );
  async function fetchPage(reset) {
    if (reset) offset = 0;
    let items;
    try {
      items = await load({ q, tab, offset });
    } catch (e) {
      return toast(e.message, true);
    }
    if (reset) body.replaceChildren();
    for (const it of items) {
      const tr = row(it);
      tr.classList.add('click');
      tr.addEventListener('click', () => onRow(it));
      body.append(tr);
    }
    offset += items.length;
    more.hidden = items.length < 50;
    empty.hidden = body.children.length > 0;
  }
  render(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, title), subtitle && h('span', { class: 'muted' }, subtitle))),
    h('div', { class: 'toolbar' }, search, tabBar),
    h('div', { class: 'table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, c)))), body), empty),
    h('div', { class: 'more' }, more),
  );
  fetchPage(true);
  return () => fetchPage(true);
}

let refreshList = () => {};

// ---------- usuários ----------

function users() {
  refreshList = listPage({
    title: 'Usuários',
    subtitle: 'Clique numa pessoa para ver detalhes e moderar.',
    placeholder: 'Buscar por nome, @usuário, email ou id',
    tabs: [
      { id: 'all', label: 'Todos' },
      { id: 'online', label: 'Online' },
      { id: 'banned', label: 'Suspensos' },
      { id: 'bots', label: 'Bots' },
    ],
    initialTab: 'all',
    load: ({ q, tab, offset }) => api('GET', `/admin/users?q=${encodeURIComponent(q)}&filter=${tab}&offset=${offset}`),
    head: ['Pessoa', 'Email', 'Status', 'Servidores', 'Mensagens', 'Denúncias', 'Entrou'],
    row: (u) =>
      h(
        'tr',
        {},
        h('td', {}, who(u)),
        h('td', {}, u.email || h('span', { class: 'muted' }, '—'), u.google ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'Google') : null),
        h('td', {}, banned(u.bannedUntil) ? h('span', { class: 'pill red' }, 'Suspenso') : null, u.admin ? h('span', { class: 'pill violet' }, 'Admin') : null, u.botServerId ? h('span', { class: 'pill' }, 'Bot') : null, h('span', {}, h('span', { class: u.online ? 'dot on' : 'dot' }), u.online ? 'online' : 'offline')),
        h('td', {}, num(u.serverCount)),
        h('td', {}, num(u.messageCount)),
        h('td', {}, u.reportCount ? h('span', { class: 'pill sun' }, num(u.reportCount)) : '0'),
        h('td', { title: date(u.createdAt) }, ago(u.createdAt)),
      ),
    onRow: (u) => openUser(u.id),
  });
}

function drawer(...nodes) {
  // Listas (map) e nulos podem vir misturados: achata tudo antes de pôr na tela.
  const flat = nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false);
  $('#drawer-panel').replaceChildren(h('button', { class: 'btn ghost small close', onclick: closeDrawer }, 'Fechar'), ...flat);
  $('#drawer').hidden = false;
  $('#drawer-panel').scrollTop = 0;
}
function closeDrawer() {
  $('#drawer').hidden = true;
}
$('#drawer').addEventListener('click', (e) => e.target.hasAttribute('data-close') && closeDrawer());
document.addEventListener('keydown', (e) => e.key === 'Escape' && $('#dialog').hidden && closeDrawer());

const BAN_OPTIONS = [
  { value: '1', label: '1 dia' },
  { value: '3', label: '3 dias' },
  { value: '7', label: '7 dias' },
  { value: '30', label: '30 dias' },
  { value: '0', label: 'Para sempre' },
];

async function banFlow(u, after) {
  const v = await ask({
    title: `Suspender ${u.displayName || u.username}`,
    message: 'A pessoa sai de todas as sessões e chamadas e não consegue entrar até a suspensão acabar.',
    confirm: 'Suspender',
    danger: true,
    fields: [
      { name: 'days', label: 'Duração', options: BAN_OPTIONS, value: '7' },
      { name: 'reason', label: 'Motivo (aparece para a pessoa no login)', placeholder: 'Ex.: spam' },
    ],
  });
  if (!v) return;
  const days = Number(v.days) || null;
  if (await act(() => api('POST', `/admin/users/${u.id}/ban`, { days, reason: v.reason }), 'Conta suspensa.')) after?.();
}

async function openUser(id) {
  let u;
  try {
    u = await api('GET', `/admin/users/${id}`);
  } catch (e) {
    return toast(e.message, true);
  }
  const reload = () => {
    openUser(id);
    refreshList();
  };
  const isBanned = banned(u.bannedUntil);
  const protectedAccount = u.admin || u.botServerId;
  drawer(
    who(u),
    h('div', { style: 'margin-top:10px' }, isBanned ? h('span', { class: 'pill red' }, `Suspenso até ${date(u.bannedUntil)}`) : null, u.admin ? h('span', { class: 'pill violet' }, 'Admin') : null, u.online ? h('span', { class: 'pill green' }, 'Online') : h('span', { class: 'pill' }, 'Offline'), u.inCall ? h('span', { class: 'pill green' }, 'Em chamada') : null),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Id'),
      h('dd', {}, u.id),
      h('dt', {}, 'Email'),
      h('dd', {}, u.email ? `${u.email}${u.emailVerified ? ' (confirmado)' : ' (não confirmado)'}` : '—'),
      h('dt', {}, 'Login'),
      h('dd', {}, [u.hasPassword ? 'senha' : null, u.google ? 'Google' : null].filter(Boolean).join(' + ') || '—'),
      h('dt', {}, 'Criada em'),
      h('dd', {}, date(u.createdAt)),
      h('dt', {}, 'Última mensagem'),
      h('dd', {}, u.lastMessageAt ? `${date(u.lastMessageAt)} (${ago(u.lastMessageAt)})` : '—'),
      h('dt', {}, 'Mensagens'),
      h('dd', {}, num(u.messageCount)),
      h('dt', {}, 'Anexos'),
      h('dd', {}, `${num(u.attachmentCount)} (${bytes(u.attachmentBytes)})`),
      h('dt', {}, 'Amigos'),
      h('dd', {}, num(u.friendCount)),
      u.bio ? [h('dt', {}, 'Bio'), h('dd', {}, u.bio)] : null,
      isBanned && u.banReason ? [h('dt', {}, 'Motivo'), h('dd', {}, u.banReason)] : null,
    ),
    protectedAccount
      ? h('p', { class: 'muted' }, u.admin ? 'Conta de administrador: sem ações de moderação.' : 'Bot de música: é apagado junto com o servidor.')
      : h(
          'div',
          { class: 'actions' },
          isBanned
            ? h('button', { class: 'btn', onclick: async () => (await act(() => api('DELETE', `/admin/users/${id}/ban`), 'Suspensão removida.')) && reload() }, 'Remover suspensão')
            : h('button', { class: 'btn danger', onclick: () => banFlow(u, reload) }, 'Suspender'),
          h('button', { class: 'btn', onclick: async () => (await ask({ title: 'Derrubar sessões', message: 'A pessoa sai do app em todos os aparelhos e precisa entrar de novo.', confirm: 'Derrubar' })) && act(() => api('POST', `/admin/users/${id}/logout`), 'Sessões derrubadas.') }, 'Derrubar sessões'),
          h(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                if (!(await ask({ title: 'Apagar todas as mensagens', message: `Apaga as ${num(u.messageCount)} mensagens dessa conta (servidores e DMs). Não dá para desfazer.`, confirm: 'Apagar mensagens', danger: true }))) return;
                await act(() => api('DELETE', `/admin/users/${id}/messages`), 'Mensagens apagadas.');
                reload();
              },
            },
            'Apagar mensagens',
          ),
          h(
            'button',
            {
              class: 'btn danger solid',
              onclick: async () => {
                const v = await ask({
                  title: 'Apagar conta',
                  message: 'Tira nome, email, foto e bio, sai dos servidores (os que a pessoa criou continuam) e suspende para sempre. Não dá para desfazer.',
                  confirm: 'Apagar conta',
                  danger: true,
                  fields: [{ name: 'messages', label: 'Mensagens', options: [{ value: 'keep', label: 'Manter as mensagens' }, { value: 'delete', label: 'Apagar as mensagens também' }], value: 'keep' }],
                });
                if (!v) return;
                if (await act(() => api('DELETE', `/admin/users/${id}`, { deleteMessages: v.messages === 'delete' }), 'Conta apagada.')) reload();
              },
            },
            'Apagar conta',
          ),
        ),
    h('h2', {}, `Servidores (${u.servers.length})`),
    u.servers.length
      ? h('div', { class: 'list' }, u.servers.map((s) => h('div', { class: 'row', style: 'cursor:pointer', onclick: () => openServer(s.id) }, h('div', {}, h('b', {}, s.name), s.ownerId === u.id ? h('span', { class: 'pill violet', style: 'margin-left:6px' }, 'Dono') : null), h('span', { class: 'muted small' }, `${num(s.memberCount)} membros`))))
      : h('p', { class: 'muted' }, 'Não está em nenhum servidor.'),
    userTabs(u, id),
  );
}

/** Abas da ficha: mensagens recentes e o histórico completo de denúncias (mais recentes primeiro). */
function userTabs(u, id) {
  const reportItem = (r) =>
    h(
      'div',
      { class: 'msg' },
      h('div', { class: 'meta' }, h('span', {}, `${r.reason || r.kind} · por @${r.reporterUsername || '?'}`), h('span', { title: date(r.createdAt) }, `${statusLabel(r.status)} · ${date(r.createdAt)} (${ago(r.createdAt)})`)),
      r.messageContent ? h('div', { class: 'text' }, r.messageContent) : null,
      r.details ? h('div', { class: 'text muted' }, r.details) : null,
    );
  const messages = () => [
    h('p', { class: 'muted small' }, 'Só servidores: conversas privadas (DMs) não aparecem no painel.'),
    u.recentMessages.length
      ? u.recentMessages.map((m) =>
          h(
            'div',
            { class: 'msg' },
            h('div', { class: 'meta' }, h('span', {}, `${m.serverName} · #${m.channelName}`), h('span', {}, ago(m.createdAt), ' ', h('button', { class: 'linkish', onclick: () => deleteMessage(m.id, () => openUser(id)) }, 'apagar'))),
            h('div', { class: 'text' }, m.content || '(só anexo)'),
          ),
        )
      : h('p', { class: 'muted' }, 'Nenhuma.'),
  ];
  const reports = () => {
    const list = [...u.reports].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return list.length ? list.map(reportItem) : [h('p', { class: 'muted' }, 'Nenhuma denúncia contra essa conta.')];
  };
  const tabs = [
    { id: 'reports', label: `Denúncias contra (${u.reports.length})`, render: reports },
    { id: 'messages', label: 'Mensagens recentes', render: messages },
  ];
  const body = h('div', { style: 'margin-top:12px' });
  const bar = h('div', { class: 'tabs' });
  const show = (t) => {
    for (const b of bar.children) b.classList.toggle('on', b.dataset.tab === t.id);
    body.replaceChildren(...t.render().flat(Infinity).filter(Boolean));
  };
  for (const t of tabs) bar.append(h('button', { class: 'tab', 'data-tab': t.id, onclick: () => show(t) }, t.label));
  const wrap = h('div', { style: 'margin-top:24px' }, bar, body);
  show(tabs[0]);
  return wrap;
}

async function deleteMessage(id, after) {
  if (!(await ask({ title: 'Apagar mensagem', message: 'A mensagem some para todo mundo. Não dá para desfazer.', confirm: 'Apagar', danger: true }))) return;
  if (await act(() => api('DELETE', `/admin/messages/${id}`), 'Mensagem apagada.')) after?.();
}

// ---------- servidores ----------

function servers() {
  refreshList = listPage({
    title: 'Servidores',
    placeholder: 'Buscar por nome, dono ou id',
    load: ({ q, offset }) => api('GET', `/admin/servers?q=${encodeURIComponent(q)}&offset=${offset}`),
    head: ['Servidor', 'Dono', 'Membros', 'Online', 'Canais', 'Mensagens', 'Criado'],
    row: (s) => {
      const icon = avatar(s.name, s.iconUrl, true);
      return h(
        'tr',
        {},
        h('td', {}, h('div', { class: 'who' }, icon, h('div', {}, h('b', {}, s.name, s.tag ? ` [${s.tag}]` : ''), h('span', {}, s.isPublic ? 'Público' : 'Privado')))),
        h('td', {}, s.ownerUsername ? `@${s.ownerUsername}` : '—'),
        h('td', {}, num(s.memberCount)),
        h('td', {}, h('span', { class: `dot${s.onlineCount ? ' on' : ''}` }), num(s.onlineCount || 0)),
        h('td', {}, num(s.channelCount)),
        h('td', {}, num(s.messageCount)),
        h('td', { title: date(s.createdAt) }, ago(s.createdAt)),
      );
    },
    onRow: (s) => openServer(s.id),
  });
}

async function openServer(id) {
  let s;
  try {
    s = await api('GET', `/admin/servers/${id}`);
  } catch (e) {
    return toast(e.message, true);
  }
  drawer(
    h('h1', {}, s.name),
    h('span', { class: 'muted' }, s.isPublic ? 'Servidor público' : 'Servidor privado'),
    h(
      'dl',
      { class: 'kv' },
      h('dt', {}, 'Id'),
      h('dd', {}, s.id),
      h('dt', {}, 'Dono'),
      h('dd', {}, s.ownerUsername ? h('button', { class: 'linkish', onclick: () => openUser(s.ownerId) }, `${s.ownerName} (@${s.ownerUsername})`) : '—'),
      h('dt', {}, 'Criado em'),
      h('dd', {}, date(s.createdAt)),
      s.suspendedAt ? [h('dt', {}, 'Situação'), h('dd', {}, h('span', { class: 'pill red' }, `Suspenso ${ago(s.suspendedAt)}`))] : null,
      h('dt', {}, 'Membros'),
      h('dd', {}, num(s.memberCount)),
      h('dt', {}, 'Online agora'),
      h('dd', {}, h('span', { class: `dot${s.onlineCount ? ' on' : ''}` }), num(s.onlineCount || 0)),
      h('dt', {}, 'Mensagens'),
      h('dd', {}, num(s.messageCount)),
      s.description ? [h('dt', {}, 'Descrição'), h('dd', {}, s.description)] : null,
    ),
    h(
      'div',
      { class: 'actions' },
      s.suspendedAt
        ? h(
            'button',
            {
              class: 'btn solid',
              onclick: async () => {
                if (!(await ask({ title: `Reativar ${s.name}`, message: 'O servidor volta a funcionar para todos os membros, com tudo que tinha.', confirm: 'Reativar servidor' }))) return;
                if (await act(() => api('DELETE', `/admin/servers/${id}/suspend`), 'Servidor reativado.')) {
                  openServer(id);
                  refreshList();
                }
              },
            },
            'Reativar servidor',
          )
        : h(
            'button',
            {
              class: 'btn danger solid',
              onclick: async () => {
                if (!(await ask({ title: `Suspender ${s.name}`, message: `Desativa o servidor para os ${num(s.memberCount)} membros: ninguém manda mensagem nem entra na voz, e todos veem "Servidor suspenso.". Nada é apagado e você pode reativar depois.`, confirm: 'Suspender servidor', danger: true }))) return;
                if (await act(() => api('PUT', `/admin/servers/${id}/suspend`), 'Servidor suspenso.')) {
                  openServer(id);
                  refreshList();
                }
              },
            },
            'Suspender servidor',
          ),
    ),
    h('h2', {}, `Canais (${s.channels.length})`),
    h('div', { class: 'list' }, s.channels.map((c) => h('div', { class: 'row' }, h('span', {}, c.type === 'voice' ? '🔊 ' : '# ', c.name, c.isPrivate ? h('span', { class: 'pill', style: 'margin-left:6px' }, 'privado') : null), h('span', { class: 'muted small' }, c.type === 'voice' ? 'voz' : `${num(c.messageCount)} mensagens`)))),
    h('h2', {}, `Membros (${s.members.length}${s.memberCount > s.members.length ? ` de ${s.memberCount}` : ''})`),
    h('div', { class: 'list' }, s.members.map((m) => h('div', { class: 'row', style: 'cursor:pointer', onclick: () => openUser(m.id) }, who(m), h('span', { class: 'muted small' }, banned(m.bannedUntil) ? 'suspenso' : `entrou ${ago(m.joinedAt)}`)))),
  );
}

// ---------- denúncias e bugs ----------

const KIND = { bug: 'Bug', idea: 'Melhoria', user: 'Usuário', message: 'Mensagem', nsfw: '+18' };
const KIND_PILL = { bug: 'red', idea: 'violet', user: 'sun', message: 'sun', nsfw: 'red' };

/** Prioridade da denúncia +18: mais denúncias (e o detector concordando) = mais crítica. */
function nsfwPriority(r) {
  const score = (r.reportCount || 1) + 2 * (r.detectedCount || 0);
  if (score >= 7) return ['Crítica', 'red'];
  if (score >= 4) return ['Alta', 'sun'];
  if (score >= 2) return ['Média', 'violet'];
  return ['Normal', ''];
}
const statusLabel = (s) => ({ open: 'Aberta', resolved: 'Resolvida', dismissed: 'Descartada' })[s] || s;

function reportsPage(which) {
  const feedback = which === 'feedback';
  let status = 'open';
  let kind = feedback ? 'feedback' : 'reports';
  let offset = 0;
  const list = h('div');
  const more = h('button', { class: 'btn', onclick: () => load(false) }, 'Carregar mais');
  const tabs = (items, current, set) =>
    h(
      'div',
      { class: 'tabs' },
      items.map(([id, label]) =>
        h(
          'button',
          {
            class: id === current ? 'on' : '',
            onclick: (e) => {
              set(id);
              for (const b of e.target.parentNode.children) b.classList.toggle('on', b === e.target);
              load(true);
            },
          },
          label,
        ),
      ),
    );
  async function load(reset) {
    if (reset) offset = 0;
    let items;
    try {
      items = await api('GET', `/admin/reports?kind=${kind}&status=${status}&offset=${offset}`);
    } catch (e) {
      return toast(e.message, true);
    }
    if (reset) list.replaceChildren();
    for (const r of items) list.append(reportCard(r, () => load(true)));
    offset += items.length;
    more.hidden = items.length < 50;
    if (!list.children.length) list.append(h('div', { class: 'empty' }, feedback ? 'Nenhum relato aqui.' : 'Nenhuma denúncia aqui.'));
  }
  render(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, feedback ? 'Bugs e melhorias' : 'Denúncias'), h('span', { class: 'muted' }, feedback ? 'Enviados pelo app em "Reportar", abaixo de Solicitações.' : 'Denúncias de usuários e mensagens feitas no app.'))),
    h(
      'div',
      { class: 'toolbar' },
      tabs([['open', 'Abertas'], ['resolved', 'Resolvidas'], ['dismissed', 'Descartadas'], ['', 'Todas']], status, (v) => (status = v)),
      tabs(feedback ? [['feedback', 'Tudo'], ['bug', 'Bugs'], ['idea', 'Melhorias']] : [['reports', 'Tudo'], ['user', 'Usuários'], ['message', 'Mensagens'], ['nsfw', '+18']], kind, (v) => (kind = v)),
    ),
    list,
    h('div', { class: 'more' }, more),
  );
  load(true);
}


/** Cópia da mensagem denunciada (guardada na hora da denúncia: vale mesmo se ela for apagada). */
function snapshotView(r) {
  let m = null;
  try {
    m = r.messageSnapshot ? JSON.parse(r.messageSnapshot) : null;
  } catch {
    m = null;
  }
  if (!m) return r.messageContent ? h('div', { class: 'quote' }, r.messageContent) : null;
  const where = m.server ? `${m.server.name} · #${m.channel?.name || '?'}` : 'Conversa privada';
  const before = m.before || [];
  const after = m.after || [];
  // Na denunciada, mostra as cópias guardadas (imagens de verdade) em vez do nome do arquivo.
  const shots = ((r.kind === 'message' || r.kind === 'nsfw') && r.images) || [];
  const files = (x, hit) =>
    hit && shots.length
      ? shotsView(shots, r.kind === 'nsfw')
      : x.attachments?.length
        ? h('div', { class: 'muted small' }, `📎 ${x.attachments.map((a) => a.filename).join(', ')}`)
        : null;
  if (!before.length && !after.length) {
    return h(
      'div',
      { class: 'quote' },
      h('div', { class: 'muted small', style: 'margin-bottom:4px' }, h('b', { style: 'color:var(--fg)' }, m.author?.displayName || '?'), ` @${m.author?.username || '?'} · ${where} · ${date(m.createdAt)}`, m.editedAt ? ` (editada ${date(m.editedAt)})` : '', ` · id ${m.id}`),
      m.content || !shots.length ? msgText(m.content) : null,
      files(m, true),
    );
  }
  // Contexto guardado na hora da denúncia: até 5 antes e 5 depois, com a denunciada destacada.
  const row = (x, hit) =>
    h(
      'div',
      { class: hit ? 'ctx-row hit' : 'ctx-row' },
      h(
        'div',
        { class: 'ctx-head' },
        h('b', {}, x.author?.displayName || '?'),
        h('span', { class: 'muted small' }, ` @${x.author?.username || '?'} · ${date(x.createdAt)}${x.editedAt ? ' (editada)' : ''}`),
        hit ? h('span', { class: 'pill red', style: 'margin-left:6px' }, 'denunciada') : null,
      ),
      x.content || !(hit && shots.length) ? h('div', { class: 'ctx-text' }, msgText(x.content)) : null,
      files(x, hit),
    );
  return h(
    'div',
    { class: 'ctx' },
    h('div', { class: 'muted small ctx-title' }, `Conversa em ${where} (${before.length} antes, ${after.length} depois)`),
    before.map((x) => row(x, false)),
    row(m, true),
    after.map((x) => row(x, false)),
  );
}

/** Miniaturas dos anexos (imagem abre em nova aba; outros arquivos viram link). */
function shotsView(list, sensitive = false) {
  // +18: começa borrado; o primeiro clique mostra, o segundo abre em nova aba.
  const reveal = (e) => {
    const a = e.currentTarget;
    if (a.classList.contains('blurred')) {
      e.preventDefault();
      a.classList.remove('blurred');
    }
  };
  return h(
    'div',
    { class: 'shots' },
    list.map((img) => {
      const url = `${FILES}${img.url}`;
      const kind = img.contentType || '';
      if (kind.startsWith('image/'))
        return h('a', { href: url, target: '_blank', rel: 'noopener', class: sensitive ? 'blurred' : '', onclick: sensitive ? reveal : undefined }, h('img', { src: url, alt: img.filename, loading: 'lazy' }));
      if (kind.startsWith('video/') && sensitive)
        return h('a', { href: url, target: '_blank', rel: 'noopener', class: 'blurred', onclick: reveal }, h('video', { src: url, muted: true, preload: 'metadata' }));
      return h('a', { class: 'pill', href: url, target: '_blank', rel: 'noopener' }, img.filename);
    }),
  );
}

/** Texto da mensagem: **negrito** e cartões de música ([[musica:...]]) legíveis. */
function msgText(text) {
  const t = (text || '').replace(/\[\[musica:[^\]]*\]\]\s*/g, '🎵 ').trim();
  if (!t) return h('span', { class: 'muted' }, '(sem texto)');
  return t.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((part) => (part.startsWith('**') && part.endsWith('**') && part.length > 4 ? h('b', {}, part.slice(2, -2)) : part));
}

function reportCard(r, reload) {
  const setStatus = async (s) => {
    const v = s === 'open' ? { note: '' } : await ask({ title: s === 'resolved' ? 'Marcar como resolvida' : 'Descartar', confirm: s === 'resolved' ? 'Resolver' : 'Descartar', fields: [{ name: 'note', label: 'Anotação (opcional, só você vê)', multiline: true }] });
    if (!v) return;
    if (await act(() => api('PATCH', `/admin/reports/${r.id}`, { status: s, note: v.note || undefined }), 'Atualizado.')) reload();
  };
  const where = r.serverName ? `${r.serverName} · #${r.channelName || '?'}` : r.channelType ? 'Conversa privada' : null;
  return h(
    'div',
    { class: 'report' },
    h(
      'div',
      { class: 'report-top' },
      h('div', {}, h('span', { class: `pill ${KIND_PILL[r.kind] || ''}` }, KIND[r.kind] || r.kind), r.reason ? h('b', {}, r.reason) : null, r.status !== 'open' ? h('span', { class: 'pill', style: 'margin-left:6px' }, statusLabel(r.status)) : null),
      h('span', { class: 'muted small', title: date(r.createdAt) }, `${ago(r.createdAt)} · por `, h('button', { class: 'linkish', onclick: () => openUser(r.reporterId) }, `@${r.reporterUsername || '?'}`)),
    ),
    r.targetUserId &&
      h('div', { style: 'margin-top:8px' }, 'Contra ', h('button', { class: 'linkish', onclick: () => openUser(r.targetUserId) }, `${r.targetName || '?'} (@${r.targetUsername || '?'})`), banned(r.targetBannedUntil) ? h('span', { class: 'pill red', style: 'margin-left:6px' }, 'suspenso') : null, where ? h('span', { class: 'muted' }, ` em ${where}`) : null),
    snapshotView(r),
    r.kind === 'nsfw' &&
      h(
        'div',
        { style: 'margin-top:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center' },
        (() => {
          const [label, color] = nsfwPriority(r);
          return h('span', { class: `pill ${color}` }, `Prioridade ${label}`);
        })(),
        h('span', { class: 'pill' }, `${num(r.reportCount || 1)} ${(r.reportCount || 1) === 1 ? 'denúncia' : 'denúncias'}`),
        h('span', { class: 'pill' }, `Detector: ${num(r.detectedCount || 0)} de ${num(r.reportCount || 1)} acharam +18`),
      ),
    r.details && h('p', { class: 'details' }, r.kind === 'message' || r.kind === 'user' || r.kind === 'nsfw' ? h('span', { class: 'muted small' }, 'Relato de quem denunciou: ') : null, r.details),
    r.kind !== 'message' && r.images?.length ? shotsView(r.images) : null,
    (r.platform || r.version) && h('p', { class: 'muted small', style: 'margin:8px 0 0' }, [r.platform, r.version && `versão ${r.version}`].filter(Boolean).join(' · ')),
    r.note && h('p', { class: 'muted small', style: 'margin:8px 0 0' }, `Anotação: ${r.note}`),
    h(
      'div',
      { class: 'actions' },
      r.kind === 'nsfw' && r.attachmentId
        ? [
            h('button', { class: 'btn danger small', onclick: async () => (await act(() => api('PUT', `/admin/attachments/${r.attachmentId}/nsfw`, { nsfw: true }), 'Fixado como +18.')) && reload() }, 'É +18 (fixar)'),
            h('button', { class: 'btn small', onclick: async () => (await act(() => api('PUT', `/admin/attachments/${r.attachmentId}/nsfw`, { nsfw: false }), 'Marcado como não +18.')) && reload() }, 'Não é +18'),
          ]
        : r.status === 'open'
          ? [h('button', { class: 'btn primary small', onclick: () => setStatus('resolved') }, 'Resolver'), h('button', { class: 'btn small', onclick: () => setStatus('dismissed') }, 'Descartar')]
          : h('button', { class: 'btn small', onclick: () => setStatus('open') }, 'Reabrir'),
      r.messageId && r.messageExists ? h('button', { class: 'btn danger small', onclick: () => deleteMessage(r.messageId, reload) }, 'Apagar mensagem') : r.messageId ? h('span', { class: 'muted small', style: 'align-self:center' }, 'mensagem já apagada') : null,
      r.targetUserId && !banned(r.targetBannedUntil) ? h('button', { class: 'btn danger small', onclick: () => banFlow({ id: r.targetUserId, displayName: r.targetName, username: r.targetUsername }, reload) }, 'Suspender autor') : null,
    ),
  );
}

// ---------- administradores ----------

async function admins() {
  loading();
  let list;
  try {
    list = await api('GET', '/admin/admins');
  } catch (e) {
    return render(h('p', { class: 'error' }, e.message));
  }
  const input = h('input', { placeholder: '@usuário ou id da conta' });
  const add = async () => {
    const v = input.value.trim();
    if (!v) return;
    if (await act(() => api('PUT', `/admin/admins/${encodeURIComponent(v)}`), 'Administrador adicionado.')) admins();
  };
  render(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Administradores'), h('span', { class: 'muted' }, isOwner ? 'Quem pode abrir o backoffice. Quem não está aqui é mandado para o app.' : 'Só o dono do painel adiciona ou remove administradores.'))),
    isOwner ? h('div', { class: 'toolbar' }, input, h('button', { class: 'btn primary', onclick: add }, 'Adicionar')) : '',
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('tbody', {}, list.map((u) =>
          h(
            'tr',
            {},
            h('td', {}, who(u)),
            h('td', {}, u.owner ? h('span', { class: 'pill violet' }, 'Dono') : h('span', { class: 'pill' }, 'Admin')),
            h(
              'td',
              { style: 'text-align:right' },
              isOwner && !u.owner
                ? h('button', { class: 'btn danger small', onclick: async () => (await ask({ title: `Remover ${u.displayName}`, message: 'A pessoa perde o acesso ao backoffice na hora.', confirm: 'Remover', danger: true })) && (await act(() => api('DELETE', `/admin/admins/${u.id}`), 'Removido.')) && admins() }, 'Remover')
                : null,
            ),
          ),
        )),
      ),
    ),
  );
}

// ---------- registro ----------

const ACTIONS = { ban: 'Suspendeu', unban: 'Removeu suspensão', logout: 'Derrubou sessões', delete_messages: 'Apagou mensagens de', delete_user: 'Apagou a conta', delete_server: 'Apagou o servidor', delete_message: 'Apagou mensagem', report: 'Mudou denúncia', add_admin: 'Tornou admin', remove_admin: 'Tirou admin de', nsfw_confirm: 'Fixou +18 no anexo', nsfw_reject: 'Disse que não é +18 o anexo' };

async function log() {
  loading();
  let items;
  try {
    items = await api('GET', '/admin/log');
  } catch (e) {
    return render(h('p', { class: 'error' }, e.message));
  }
  render(
    h('div', { class: 'head' }, h('div', {}, h('h1', {}, 'Registro'), h('span', { class: 'muted' }, 'Tudo que foi feito pelo painel.'))),
    h(
      'div',
      { class: 'table-wrap' },
      items.length
        ? h(
            'table',
            {},
            h('thead', {}, h('tr', {}, ['Quando', 'Admin', 'Ação', 'Alvo', 'Detalhe'].map((c) => h('th', {}, c)))),
            h(
              'tbody',
              {},
              items.map((l) => h('tr', {}, h('td', {}, date(l.createdAt)), h('td', {}, `@${l.adminUsername || '?'}`), h('td', {}, ACTIONS[l.action] || l.action), h('td', {}, ['ban', 'unban', 'logout', 'delete_messages', 'delete_user', 'add_admin', 'remove_admin'].includes(l.action) ? h('button', { class: 'linkish', onclick: () => openUser(l.target) }, l.target) : l.target), h('td', { style: 'white-space:normal' }, l.detail))),
            ),
          )
        : h('div', { class: 'empty' }, 'Nada ainda.'),
    ),
  );
}

boot();
