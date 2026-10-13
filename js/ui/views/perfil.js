// Perfil da staff (plano 09): #/perfil (o meu) e #/perfil/<discord_id> (de outra pessoa).
// Tudo que aparece vem de adapter.getProfile / listProfileHistory; a privacidade é aplicada no banco (20_perfil.sql).
// Texto do banco entra sempre como nó de texto (h()); o Markdown dos procedimentos passa por render-md.js.
import { h, icon, toast } from '../dom.js';
import { formatDate, roleBadge, teamBadge } from '../components.js';
import { MEETING_STATUS_LABELS, formatMeetingDate, meetingStatus } from '../../core/agenda.js';
import { AREA_ROLE_LABELS, describeAreaEvent } from '../../core/areas.js';
import {
  BANNER_PALETTE, DEFAULT_BANNER, PROFILE_ERRORS, PROFILE_LIMITS, initialsOf, safeAvatar, safeBanner, validateProfileEdit,
} from '../../core/perfil.js';
import { renderRichMarkdownInto } from '../../core/render-md.js';
import { SCORE_FIELDS, receivedAverages, scoreAverage, scoreBand } from '../../core/diretoria.js';
import { attachFormDraft } from '../draft.js';
import { formField, showFieldErrors } from './gabarito.js';
import { renderMessage } from './message.js';

const HISTORY_PAGE = 20;
const TABS = Object.freeze([['areas', 'Áreas'], ['reunioes', 'Reuniões'], ['procedimentos', 'Procedimentos'], ['historico', 'Histórico']]);
const AREA_PROCEDURE_STATUS = Object.freeze({ rascunho: 'Rascunho', publicado: 'Publicado' });

const errorText = (error) => error?.details?.errors?._ ?? Object.values(error?.details?.errors ?? {})[0] ?? error?.message ?? 'Algo deu errado.';

/** Avatar: foto do Discord (se houver e carregar) ou as iniciais. */
function avatarEl(profile, sessionUrl) {
  const url = safeAvatar(profile.avatar_url) ?? (profile.self ? safeAvatar(sessionUrl) : null);
  const initials = h('div', { class: 'perfil-avatar perfil-avatar--initials', 'aria-hidden': 'true' }, initialsOf(profile.display_name));
  if (!url) return initials;
  const img = h('img', { class: 'perfil-avatar', src: url, alt: '', width: 88, height: 88, referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(initials));
  return img;
}

function empty(text) {
  return h('p', { class: 'perfil-empty' }, text);
}

export function renderPerfil(app, discordId) {
  if (!app.feature('perfil')) {
    renderMessage(app, { title: 'Perfil indisponível', text: 'O módulo de Perfil ainda não foi instalado no banco de dados.' });
    return null;
  }
  const target = discordId || app.state.staff.discord_id;
  let alive = true;
  const ctx = { profile: null, tab: 'areas', history: null, editing: false, score: null, received: null };

  const root = h('div', { class: 'main-inner perfil-page' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(root);

  /* ---------- cabeçalho ---------- */
  function drawHeader() {
    const p = ctx.profile;
    const banner = h('div', { class: 'perfil-banner', 'aria-hidden': 'true' });
    banner.style.setProperty('--perfil-cor', safeBanner(p.banner_color));
    return h('header', { class: 'perfil-head' },
      banner,
      h('div', { class: 'perfil-id' },
        avatarEl(p, app.state.session?.user?.avatar_url),
        h('div', { class: 'perfil-id-info' },
          h('h1', { class: 'perfil-name page-title', tabindex: '-1' }, p.display_name),
          h('p', { class: 'perfil-badges' }, roleBadge(p.role), (p.teams ?? []).map(teamBadge),
            !p.active && h('span', { class: 'badge badge--revisar' }, 'Inativo')),
          h('p', { class: 'perfil-discord' }, 'Discord ID ', h('code', { class: 'staff-id' }, p.discord_id))),
        p.self && h('button', {
          type: 'button', class: 'btn', id: 'perfil-edit-btn',
          onclick: () => { ctx.editing = !ctx.editing; draw(); },
        }, icon('pencil'), ctx.editing ? 'Fechar edição' : 'Editar perfil')),
      !p.perfil_publico && h('p', { class: 'banner banner--warn', id: 'perfil-private-note' },
        '⚠ Perfil privado: visível apenas para você e gestores.'),
      h('p', { class: 'perfil-bio', id: 'perfil-bio' }, p.bio || (p.self ? 'Escreva algo sobre você em "Editar perfil".' : 'Sem apresentação.')),
      p.entrou_em && h('p', { class: 'perfil-since' }, `Na staff desde ${formatDate(p.entrou_em)}`),
      // Painel da Diretoria (plano 10): média das últimas 3 avaliações marcadas como visíveis. Só o dono e a Diretoria recebem.
      ctx.score && h('p', { class: 'perfil-since perfil-nota', id: 'perfil-nota' },
        `★ Nota da Diretoria: ${String(ctx.score.media.toFixed(1)).replace('.', ',')} (${ctx.score.total === 1 ? '1 avaliação' : `média das últimas ${ctx.score.total} avaliações`})`));
  }

  /* ---------- números ---------- */
  function drawStats() {
    const p = ctx.profile;
    const card = (key, label, value) => h('div', { class: 'perfil-stat', dataset: { stat: key } },
      h('span', { class: 'perfil-stat-value' }, value == null ? '–' : String(value)),
      h('span', { class: 'perfil-stat-label' }, label));
    return h('section', { class: 'perfil-stats', 'aria-label': 'Números' },
      card('reunioes_criadas', 'Reuniões criadas', p.stats.reunioes_criadas),
      card('reunioes_convocado', 'Reuniões convocado', p.stats.reunioes_convocado),
      card('procedimentos', 'Procedimentos', p.stats.procedimentos),
      card('acoes', 'Ações no histórico', p.stats.acoes));
  }

  /* ---------- edição (só o dono) ---------- */
  function drawEditor() {
    const p = ctx.profile;
    const state = { banner: safeBanner(p.banner_color) };
    const bio = formField('perfil-bio-input', 'Sobre mim', h('textarea', { class: 'input', rows: 3, maxlength: PROFILE_LIMITS.bio }, p.bio ?? ''));
    const counter = h('p', { class: 'field-hint', id: 'perfil-bio-count', 'aria-live': 'polite' });
    const updateCounter = () => { counter.textContent = `${bio.input.value.length} de ${PROFILE_LIMITS.bio} caracteres`; };
    bio.input.addEventListener('input', updateCounter);
    updateCounter();

    const hex = h('input', { class: 'input', id: 'perfil-banner-hex', type: 'text', value: state.banner, maxlength: 7, 'aria-label': 'Cor do banner em hexadecimal' });
    const swatches = h('div', { class: 'perfil-swatches', role: 'group', 'aria-label': 'Cores prontas do banner' });
    const drawSwatches = () => swatches.replaceChildren(...BANNER_PALETTE.map((c) => {
      const b = h('button', {
        type: 'button', class: 'perfil-swatch', 'aria-label': `Cor ${c}`, 'aria-pressed': String(c.toLowerCase() === state.banner.toLowerCase()),
        onclick: () => { state.banner = c; hex.value = c; drawSwatches(); },
      });
      b.style.setProperty('--perfil-cor', c);
      return b;
    }));
    hex.addEventListener('input', () => { state.banner = hex.value.trim(); drawSwatches(); });
    drawSwatches();

    const publico = h('input', { type: 'checkbox', id: 'perfil-publico', checked: p.perfil_publico ? true : null });
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const fields = { bio, banner_color: { error: h('p', { class: 'field-error', hidden: true }) } };
    const save = h('button', { type: 'submit', class: 'btn btn--primary', id: 'perfil-save' }, 'Salvar');
    const form = h('form', { class: 'perfil-editor panel', id: 'perfil-editor', novalidate: true },
      h('h2', { class: 'block-title' }, icon('pencil'), 'Editar perfil'),
      bio.el, counter,
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'perfil-banner-hex' }, 'Cor do banner'),
        swatches, hex, fields.banner_color.error),
      h('label', { class: 'perfil-check' }, publico, ' Perfil público (a staff toda pode ver). Desmarcado, só você e a gestão veem.'),
      general,
      h('div', { class: 'perfil-editor-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'perfil-cancel', onclick: () => { draft.clear(); ctx.editing = false; draw(); } }, 'Cancelar'),
        save));

    const draft = attachFormDraft(app, 'perfil', form);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const patch = { bio: bio.input.value, banner_color: hex.value.trim(), perfil_publico: publico.checked };
      const { valid, errors } = validateProfileEdit(patch);
      if (!valid) { showFieldErrors(fields, general, { details: { errors } }); return; }
      save.disabled = true;
      const r = await app.adapter.updateMyProfile(patch);
      save.disabled = false;
      if (!alive) return;
      if (r.error) { showFieldErrors(fields, general, r.error); return; }
      draft.clear();
      toast('Perfil salvo.');
      ctx.editing = false;
      await load();
    });
    return form;
  }

  /* ---------- abas ---------- */
  // Plano 11: a aba Avaliações só existe para o dono do perfil e para a Diretoria (o banco devolve null para os outros).
  const tabList = () => (ctx.received ? [...TABS, ['avaliacoes', 'Avaliações']] : TABS);

  function drawTabs() {
    return h('div', { class: 'areas-tabs perfil-tabs', role: 'tablist', 'aria-label': 'Seções do perfil' },
      tabList().map(([key, label]) => h('button', {
        type: 'button', class: 'areas-tab', role: 'tab', id: `perfil-tab-${key}`, 'aria-selected': String(ctx.tab === key),
        onclick: () => { ctx.tab = key; draw(); if (key === 'historico') loadHistory(true); },
      }, label)));
  }

  function panelAreas() {
    const list = ctx.profile.areas;
    if (!list.length) return empty('Nenhuma área para mostrar.');
    return h('ul', { class: 'perfil-cards' }, list.map((a) => {
      const card = h('li', { class: 'perfil-card perfil-card--area' },
        h('a', { class: 'perfil-card-link', href: `#/areas/${a.slug}` },
          h('strong', {}, a.nome),
          h('span', { class: 'badge' }, AREA_ROLE_LABELS[a.papel] ?? a.papel),
          a.status !== 'ativa' && h('span', { class: 'badge badge--revisar' }, 'Arquivada')));
      card.style.setProperty('--perfil-cor', safeBanner(a.cor));
      return card;
    }));
  }

  function panelMeetings() {
    const p = ctx.profile;
    if (!p.reunioes_visiveis) return empty('Seu cargo não permite ver a Agenda.');
    if (!p.reunioes.length) return empty('Nenhuma reunião para mostrar.');
    return h('ul', { class: 'perfil-cards' }, p.reunioes.map((m) => h('li', {},
      h('details', { class: 'areas-proc perfil-item' },
        h('summary', {},
          h('span', { class: 'areas-proc-title' }, m.title),
          h('span', { class: 'badge' }, m.relacao === 'criada' ? 'Criou' : 'Convocado'),
          h('span', { class: 'badge badge--status' }, MEETING_STATUS_LABELS[meetingStatus(m)]),
          h('span', { class: 'perfil-when' }, formatMeetingDate(m.starts_at))),
        h('p', { class: 'areas-proc-body' }, m.description || 'Sem descrição.')))));
  }

  function panelProcedures() {
    const list = ctx.profile.procedimentos;
    if (!list.length) return empty('Nenhum procedimento para mostrar.');
    return h('ul', { class: 'perfil-cards' }, list.map((x) => {
      const body = h('div', { class: 'areas-proc-body prose' });
      const details = h('details', { class: 'areas-proc perfil-item' },
        h('summary', {},
          h('span', { class: 'areas-proc-title' }, x.titulo),
          h('span', { class: 'badge' }, x.area_nome),
          x.status !== 'publicado' && h('span', { class: 'badge badge--revisar' }, AREA_PROCEDURE_STATUS[x.status] ?? x.status),
          h('span', { class: 'perfil-when' }, formatDate(x.atualizado_em))),
        body);
      // O Markdown só é montado quando a pessoa abre o item.
      details.addEventListener('toggle', () => { if (details.open && !body.hasChildNodes()) renderRichMarkdownInto(body, x.conteudo || '*Sem conteúdo.*'); });
      return h('li', {}, details);
    }));
  }

  /** Avaliações da Diretoria recebidas: só as visíveis ao avaliado e nunca quem avaliou (perfil_avaliacoes_recebidas, SQL 22). */
  function panelEvaluations() {
    const list = ctx.received ?? [];
    const fmt = (n) => (n == null ? '–' : Number(n).toFixed(1).replace('.', ','));
    if (!list.length) return empty('Nenhuma avaliação registrada ainda.');
    const avg = receivedAverages(list);
    return h('div', { id: 'perfil-avaliacoes' },
      h('p', { class: 'panel-text' }, 'Avaliações da Diretoria marcadas como visíveis. Quem avaliou não aparece.'),
      h('div', { class: 'perfil-stats perfil-eval-avg', 'aria-label': 'Médias das avaliações' }, SCORE_FIELDS.map((f) => h('div', { class: 'perfil-stat' },
        h('span', { class: 'perfil-stat-value' }, fmt(avg[f.key])), h('span', { class: 'perfil-stat-label' }, f.label)))),
      h('ul', { class: 'perfil-cards', id: 'perfil-eval-list' }, list.map((e) => {
        const media = scoreAverage(e);
        const band = scoreBand(media);
        const dates = e.periodo_inicio ? `${e.periodo_inicio.slice(8, 10)}/${e.periodo_inicio.slice(5, 7)} a ${e.periodo_fim.slice(8, 10)}/${e.periodo_fim.slice(5, 7)}/${e.periodo_fim.slice(0, 4)}` : '';
        return h('li', { class: 'perfil-card perfil-eval' },
          h('div', { class: 'perfil-eval-head' },
            h('strong', {}, `Período ${dates}`),
            e.area_nome && h('span', { class: 'badge' }, e.area_nome),
            band && h('span', { class: 'badge perfil-eval-band', dataset: { tone: band.tone } }, `Média ${fmt(media)} · ${band.label}`)),
          h('p', { class: 'perfil-eval-notes' }, SCORE_FIELDS.map((f) => `${f.label} ${fmt(e[f.key])}`).join(' · ')),
          e.comentario && h('p', { class: 'perfil-eval-comment' }, e.comentario),
          h('p', { class: 'perfil-when' }, `${formatDate(e.criado_em)} · Avaliação anônima`));
      })));
  }

  async function loadHistory(reset) {
    if (reset && ctx.history) return;
    const offset = ctx.history?.items.length ?? 0;
    const r = await app.adapter.listProfileHistory(target, { limit: HISTORY_PAGE, offset });
    if (!alive) return;
    if (r.error) { app.reportError(r.error, 'Não foi possível carregar o histórico.'); return; }
    ctx.history = { items: [...(ctx.history?.items ?? []), ...r.data.items], total: r.data.total };
    if (ctx.tab === 'historico') draw();
  }

  function panelHistory() {
    if (!ctx.history) return h('p', { class: 'panel-text' }, 'Carregando…');
    if (!ctx.history.items.length) return empty('Nenhuma ação registrada.');
    const more = ctx.history.items.length < ctx.history.total;
    return h('div', {},
      h('ul', { class: 'areas-history perfil-history' }, ctx.history.items.map((e) => h('li', { class: 'perfil-history-row' },
        icon(e.entidade === 'comunicacao' ? 'send' : 'history'),
        h('span', { class: 'perfil-history-text' }, describeAreaEvent({ ...e, detalhes: { nome: e.nome } }),
          e.area_nome && h('span', { class: 'perfil-history-area' }, ` · ${e.area_nome}`)),
        h('span', { class: 'perfil-when' }, formatDate(e.criado_em, { time: true }))))),
      more && h('button', { type: 'button', class: 'btn', id: 'perfil-more', onclick: () => loadHistory(false) },
        `Carregar mais (${ctx.history.items.length} de ${ctx.history.total})`));
  }

  /* ---------- montagem ---------- */
  function draw() {
    const p = ctx.profile;
    const panel = h('div', { class: 'perfil-panel', role: 'tabpanel', 'aria-labelledby': `perfil-tab-${ctx.tab}`, id: 'perfil-panel' },
      ctx.tab === 'areas' ? panelAreas()
        : ctx.tab === 'reunioes' ? panelMeetings()
          : ctx.tab === 'procedimentos' ? panelProcedures()
            : ctx.tab === 'avaliacoes' && ctx.received ? panelEvaluations() : panelHistory());
    // replaceChildren escreveria "false" como texto: o filter tira os itens condicionais ausentes.
    root.replaceChildren(...[
      !p.self && h('a', { class: 'back', href: '#/equipe' }, icon('arrow-left'), 'Voltar'),
      drawHeader(),
      ctx.editing && p.self && drawEditor(),
      drawStats(),
      drawTabs(),
      panel,
    ].filter(Boolean));
  }

  async function load() {
    const wantsScore = app.feature('diretoria') && (target === app.state.staff.discord_id || app.can('diretoria.ver'));
    const wantsReceived = app.feature('avaliacoes_area') && (target === app.state.staff.discord_id || app.can('diretoria.ver'));
    const [r, score, received] = await Promise.all([
      app.adapter.getProfile(target), wantsScore ? app.adapter.getDirectorScore(target) : null,
      wantsReceived ? app.adapter.listReceivedEvaluations(target) : null,
    ]);
    if (!alive) return;
    ctx.score = score && !score.error ? score.data : null;
    ctx.received = received && !received.error ? received.data : null;
    if (ctx.tab === 'avaliacoes' && !ctx.received) ctx.tab = 'areas';
    if (r.error) {
      const notFound = r.error.code === 'NOT_FOUND';
      renderMessage(app, { title: notFound ? 'Perfil não encontrado' : 'Não foi possível abrir o perfil', text: notFound ? PROFILE_ERRORS.notFound : errorText(r.error), back: true });
      return;
    }
    if (r.data.privado) {
      renderMessage(app, { title: 'Perfil privado', text: PROFILE_ERRORS.private });
      return;
    }
    ctx.profile = r.data;
    ctx.history = null;
    draw();
    root.querySelector('h1')?.focus({ preventScroll: true });
    if (r.data.self) {
      // Guarda o avatar do Discord para os outros verem (melhor esforço; falha não atrapalha).
      const url = safeAvatar(app.state.session?.user?.avatar_url);
      if (url && url !== r.data.avatar_url) app.adapter.syncMyAvatar(url);
    }
  }

  load();
  return () => { alive = false; };
}
