// Etapa 6 · histórico de análises e entrevistas (documento 02, seção 8.2).
//   #/avaliacoes        busca por @, Discord ID, personagem ou ID da AL; filtros de tipo, situação,
//                       responsável e data. Cada um vê as próprias e as que participou;
//                       allowlist.historico vê todas (o banco decide).
//   #/avaliacoes/<id>   ficha somente leitura, com prints e o que foi enviado. O autor continua
//                       (se não enviada) ou envia de novo.
import { debounce, h, icon } from '../dom.js';
import { copyButton, formatDate } from '../components.js';
import { copyText, evaluationLines } from '../../core/allowlist.js';
import { alDenied, errorText, sendBox, setFormPrefill } from './allowlist.js';

const KIND_LABEL = { allowlist: 'Allowlist', entrevista: 'Entrevista' };
const STATUS_LABEL = { aprovado: '✓ Aprovada', reprovado: '✗ Reprovada' };
const PAGE = 100;

const statusBadge = (s) => h('span', { class: `badge al-badge--${s}` }, STATUS_LABEL[s] ?? s);
const sentBadge = (e) => (e.sent_to_discord_at
  ? h('span', { class: 'badge badge--status', title: e.discord_status }, '✉ Enviada')
  : h('span', { class: 'badge badge--revisar' }, 'Não enviada'));
const canUse = (app) => app.can('allowlist.avaliar') || app.can('allowlist.historico');

/* ============================ lista ============================ */
export function renderAlHistory(app) {
  if (alDenied(app, app.can('allowlist.historico') ? 'allowlist.historico' : 'allowlist.avaliar')) return null;
  let alive = true;
  const f = { query: '', kind: '', status: '', createdBy: '', from: '', to: '' };
  let rows = [];
  let more = false;
  const list = h('ul', { class: 'staff-list', id: 'al-history' }, h('li', { class: 'staff-empty' }, 'Carregando…'));
  const moreBtn = h('button', { type: 'button', class: 'btn', id: 'al-more', hidden: true, onclick: () => fetchPage(true) }, 'Carregar mais');
  const byWho = h('select', { class: 'input input--sm', id: 'al-f-createdBy', onchange: (e) => { f.createdBy = e.target.value; fetchPage(); } },
    h('option', { value: '' }, 'Todos'));
  const select = (key, label, options) => h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label),
    h('select', { class: 'input input--sm', id: `al-f-${key}`, onchange: (e) => { f[key] = e.target.value; fetchPage(); } },
      h('option', { value: '' }, 'Todos'), options.map(([v, t]) => h('option', { value: v }, t))));
  const dateIn = (key, label) => h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label),
    h('input', { type: 'date', class: 'input input--sm', id: `al-f-${key}`, onchange: (e) => { f[key] = e.target.value; draw(); } }));
  const search = h('input', { type: 'search', class: 'input', id: 'al-f-query', placeholder: 'Buscar por @, Discord ID, personagem ou ID da AL', 'aria-label': 'Buscar no histórico' });
  const runSearch = debounce(() => { f.query = search.value; fetchPage(); }, 250);
  search.addEventListener('input', runSearch);
  const names = new Map();

  app.els.main.replaceChildren(h('div', { class: 'main-inner al-history-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Histórico de allowlist e entrevistas'),
      h('p', { class: 'page-sub' }, app.can('allowlist.historico')
        ? 'Todas as análises e entrevistas da staff, das mais recentes para as mais antigas.'
        : 'As análises e entrevistas que você fez ou das quais participou.'),
      app.can('allowlist.avaliar') && h('div', { class: 'page-head-actions' },
        h('a', { class: 'btn btn--primary', href: '#/allowlist', id: 'al-new-analysis' }, icon('plus'), 'Nova análise'),
        h('a', { class: 'btn', href: '#/entrevista', id: 'al-new-interview' }, icon('microphone'), 'Nova entrevista'))),
    h('section', { class: 'panel' },
      search,
      h('div', { class: 'staff-filters' },
        select('kind', 'Tipo', Object.entries(KIND_LABEL)),
        select('status', 'Situação', [['aprovado', 'Aprovada'], ['reprovado', 'Reprovada']]),
        h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Responsável'), byWho),
        dateIn('from', 'De'), dateIn('to', 'Até')),
      list, moreBtn)));

  async function fetchPage(append = false) {
    const before = append ? rows[rows.length - 1]?.created_at : null;
    const res = await app.adapter.listAlEvaluations({ kind: f.kind, status: f.status, createdBy: f.createdBy, query: f.query, limit: PAGE, before });
    if (!alive) return;
    if (res.error) { app.reportError(res.error, 'Não foi possível carregar o histórico.'); return; }
    rows = append ? rows.concat(res.data) : res.data;
    more = res.data.length === PAGE;
    for (const e of rows) if (!names.has(e.created_by)) names.set(e.created_by, e.created_by_name ?? e.created_by);
    const chosen = byWho.value;
    byWho.replaceChildren(h('option', { value: '' }, 'Todos'),
      [...names].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR')).map(([v, t]) => h('option', { value: v, selected: v === chosen }, t)));
    draw();
  }

  function draw() {
    // Datas no horário do navegador (dia inteiro de "Até").
    const from = f.from ? new Date(`${f.from}T00:00:00`).getTime() : -Infinity;
    const to = f.to ? new Date(`${f.to}T23:59:59.999`).getTime() : Infinity;
    const shown = rows.filter((e) => { const t = new Date(e.created_at).getTime(); return t >= from && t <= to; });
    list.replaceChildren(...(shown.length ? shown.map((e) => h('li', { class: 'staff-row', dataset: { id: e.id } },
      h('div', { class: 'staff-who' },
        h('p', { class: 'staff-name' }, h('a', { class: 'staff-link', href: `#/avaliacoes/${e.id}` },
          e.character_name || e.author_handle || e.player_discord_id || 'Sem nome')),
        h('p', { class: 'staff-meta' }, [e.author_handle, e.player_discord_id].filter(Boolean).join(' · '),
          ` · por ${e.created_by_name ?? e.created_by} · ${formatDate(e.created_at, { time: true })}`)),
      h('div', { class: 'staff-tags' },
        h('span', { class: 'badge badge--status' }, KIND_LABEL[e.kind]), statusBadge(e.status), sentBadge(e))))
      : [h('li', { class: 'staff-empty' }, 'Nada encontrado com esses filtros.')]));
    moreBtn.hidden = !more;
  }

  fetchPage();
  return () => { alive = false; runSearch.cancel(); };
}

/* ============================ ficha ============================ */
export function renderAlDetail(app, id) {
  if (!app.feature('allowlist') || !canUse(app)) return alDenied(app) && null;
  let alive = true;
  const body = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(h('div', { class: 'main-inner al-detail-page' },
    h('a', { class: 'back', href: '#/avaliacoes' }, icon('arrow-left'), 'Histórico de allowlist e entrevistas'),
    body));

  async function load() {
    const [ev, urls] = await Promise.all([app.adapter.getAlEvaluation(id), app.adapter.getAlPrintUrls(id)]);
    if (!alive) return;
    if (ev.error) {
      body.replaceChildren(h('h1', { class: 'page-title', tabindex: '-1' }, 'Análise não encontrada'),
        h('p', { class: 'panel-text' }, errorText(ev.error)));
      return;
    }
    render(ev.data, urls.data ?? []);
  }

  function render(e, urls) {
    const mine = e.created_by === app.state.staff.discord_id && app.can('allowlist.avaliar');
    const row = (k, v) => h('div', { class: 'member-row' }, h('dt', {}, k), h('dd', {}, v || '—'));
    const lines = evaluationLines(e.kind, e.eval_flags);
    const block = (title, ico, ...content) => h('section', { class: 'panel' }, h('h2', { class: 'block-title' }, icon(ico), title), ...content);
    const others = e.participants.filter((p) => p.role !== 'responsavel');
    body.replaceChildren(...[
      h('header', { class: 'page-head' },
        h('h1', { class: 'page-title', tabindex: '-1' }, `${KIND_LABEL[e.kind]} · ${e.character_name || e.author_handle || 'Sem nome'}`),
        h('p', { class: 'page-sub' }, statusBadge(e.status), ' ', sentBadge(e), ' ',
          `Responsável: ${e.created_by_name ?? e.created_by} · ${formatDate(e.created_at, { time: true })}`),
        h('div', { class: 'page-head-actions' },
          e.kind === 'allowlist' && copyButton(() => copyText(e)),
          mine && !e.sent_to_discord_at && h('a', { class: 'btn', id: 'al-edit', href: `#/${e.kind}/${e.id}` }, icon('pencil'), 'Continuar editando'))),
      e.sent_to_discord_at
        ? h('div', { class: 'banner banner--ok', id: 'al-sent' }, icon('brand-discord'),
          h('p', {}, `Enviada ao Discord em ${formatDate(e.sent_to_discord_at, { time: true })}`, e.discord_status && ` (${e.discord_status})`, '.'))
        : e.discord_status && h('div', { class: 'banner banner--warn' }, icon('alert-triangle'), h('p', {}, `Último envio: ${e.discord_status}.`)),
      block('Dados', 'id-badge-2', h('dl', { class: 'member-data' },
        e.kind === 'allowlist' && row('ID da AL', e.al_id), row('Autor (@)', e.author_handle), row('Discord ID', e.player_discord_id),
        row('Idade (IRL)', e.player_age == null ? '' : String(e.player_age)), row('Personagem', e.character_name),
        row(e.kind === 'allowlist' ? 'Enviada em' : 'Data', e.submitted_at_text),
        others.length > 0 && row('Participantes', others.map((p) => `${p.display_name ?? p.discord_id} (${p.role})`).join(', ')))),
      block('Avaliação', 'checklist',
        lines.length ? h('ul', { class: 'plain-list', id: 'al-lines' }, lines.map((l) => h('li', {}, l.replace(/\*\*/g, '')))) : h('p', { class: 'panel-text' }, 'Nenhuma opção marcada.'),
        e.reason && h('div', { class: 'al-card-block' }, h('p', { class: 'al-card-label' }, 'Motivo'), h('p', { class: 'pre-wrap' }, e.reason)),
        e.notes && h('div', { class: 'al-card-block' }, h('p', { class: 'al-card-label' }, 'Observações'), h('p', { class: 'pre-wrap' }, e.notes))),
      e.kind === 'entrevista' && block(`Checklist (${e.checklist.length} itens marcados)`, 'list-check',
        e.checklist.length ? h('ul', { class: 'plain-list' }, e.checklist.map((c) => h('li', {}, `✓ ${c.text}`))) : h('p', { class: 'panel-text' }, 'Nenhum item marcado.')),
      e.kind === 'entrevista' && e.answers.length > 0 && block('Gabarito', 'book-2',
        h('ol', { class: 'al-q-list' }, e.answers.map((a) => h('li', { class: 'al-q' },
          h('p', {}, a.send_to_discord && h('span', { class: 'badge badge--status', title: 'Vai no resultado para o Discord' }, '✉'), ' ', h('strong', {}, a.question_text)),
          a.note && h('p', { class: 'pre-wrap' }, `↳ ${a.note}`))))),
      block(`Prints (${e.attachments.length})`, 'photo',
        urls.length
          ? h('ul', { class: 'al-thumbs', id: 'al-detail-prints' }, urls.map((u, i) => h('li', { class: 'al-thumb' },
            h('a', { href: u.url, target: '_blank', rel: 'noopener noreferrer' }, h('img', { src: u.url, alt: `Print ${i + 1}` })))))
          : h('p', { class: 'panel-text' }, e.attachments.length ? 'Prints indisponíveis.' : 'Sem prints (ou já apagados depois de 90 dias).')),
      (mine || app.can('allowlist.avaliar')) && h('div', { class: 'form-actions al-actions' },
        // Abre o formulário novo do mesmo tipo já com autor, Discord ID, personagem e idade desta ficha.
        app.can('allowlist.avaliar') && h('a', {
          class: 'btn btn--primary', id: 'al-again', href: e.kind === 'allowlist' ? '#/allowlist' : '#/entrevista',
          onclick: () => setFormPrefill(e.kind, e),
        }, icon(e.kind === 'allowlist' ? 'file-text' : 'microphone'), e.kind === 'allowlist' ? 'Nova allowlist' : 'Nova entrevista'),
        mine && sendBox(app, {
          kind: e.kind, sentAt: e.sent_to_discord_at, getId: async () => e.id, onSent: () => load(),
        })),
    ].filter(Boolean));
    app.applyOnline();
  }

  load();
  return () => { alive = false; };
}
