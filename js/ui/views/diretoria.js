// Painel da Diretoria (plano 10): #/diretoria. O painel inteiro é de quem tem diretoria.ver (Resp. Equipe, Administrador e CEO).
// Visão executiva da staff: indicadores, equipe, avaliações (0 a 10), produtividade, ocorrências e cargos.
// Plano 11 (SQL 22): #/diretoria/<aba>. Quem tem só diretoria.avaliacoes (padrão: Head Staff) abre só a aba Avaliações
// (médias por área e as avaliações do Head Staff); quem tem alinhamento.chamar vê a aba Alinhamentos. Cada aba só aparece
// com a permissão dela, e o banco confere de novo (RLS e funções).
// Plano 12: aba Decisões (#/diretoria/decisoes e #/diretoria/decisoes/<discord_id>): recomendações do Head Staff que esperam
// a Direção, cobertura do período e a ficha de decisão de cada membro (avaliações do Head Staff de 1 a 5 e da Diretoria de
// 0 a 10 lado a lado, sem converter uma na outra; ocorrências, produtividade, cargos e as decisões registradas). Registrar a
// decisão (SQL 23) abre a ação já preenchida (cargo, ocorrência ou alinhamento), sempre com confirmação.
// Tudo passa pelo adapter; a segurança de verdade é a RLS do 21_diretoria.sql. Texto do banco sempre via h()
// (nó de texto); o Markdown das regras de promoção passa por render-md.js. Gráficos em SVG próprio (como a tela
// de Produtividade): cada desenho é refeito do zero ao trocar de aba, então não sobra instância antiga.
import { debounce, downloadText, h, icon, toast } from '../dom.js';
import { formatDate, roleBadge } from '../components.js';
import { openDialog } from '../modal.js';
import { attachFormDraft } from '../draft.js';
import { renderRichMarkdownInto } from '../../core/render-md.js';
import { ROLE_LIST, assignableRoles, canManageRole, roleLabel, roleLevel } from '../../core/permissions.js';
import { initialsOf, safeAvatar } from '../../core/perfil.js';
import {
  ACTIVITY_TYPES, DIRETORIA_LIMITS, OCCURRENCE_TYPES, SCORE_FIELDS, activityLabel, averageDaysBeforePromotion, averagesByRole, canTarget,
  dashboardKpis, lastWeeks, occurrenceLabel, pendingEvaluation, productivityRanking, rankingCsv, reasonError, scoreAverage, scoreBand,
  scoreDistribution, scoreTone, validateDirectorEvaluation, validateOccurrence, weeklyTotals, weekOf,
} from '../../core/diretoria.js';
import { formField } from './gabarito.js';
import { mountTeamEvaluations } from './evaluations.js';
import { ALIGNMENT_DEADLINES, ALIGNMENT_MESSAGE_MAX, alignmentDeadline } from '../../core/allowlist.js';
import { isPeriodOpen, recommendationLabel, RECOMMENDATIONS, stars } from '../../core/workflow.js';
import {
  DECISIONS, DECISION_REASON, criterionEvolution, criterionTrend, decisionFollowUp, decisionLabel, decisionTargetError, followUpText,
  latestDecisions, pendingDecisions, periodCoverage, resolvedAction, validateDecision,
} from '../../core/avaliacoes.js';

const TABS = Object.freeze([['equipe', 'Equipe'], ['avaliacoes', 'Avaliações'], ['decisoes', 'Decisões'], ['produtividade', 'Produtividade'], ['ocorrencias', 'Ocorrências'], ['cargos', 'Cargos'], ['alinhamentos', 'Alinhamentos']]);
const ALIGN_PAGE = 20;
const CACHE_MS = 5 * 60_000;
const HISTORY_PAGE = 25;
const SERIES = 5; // cores dos gráficos: .dir-s1 a .dir-s5 (css/diretoria.css)
const PERIODS = Object.freeze({ 30: 'Últimos 30 dias', 90: 'Últimos 90 dias', 365: 'Último ano', 0: 'Tudo' });
const PROD_PERIODS = Object.freeze({ 56: 'Últimas 8 semanas', 30: 'Últimos 30 dias', 90: 'Últimos 90 dias', 365: 'Último ano' });
const OCC_ICONS = Object.freeze({ advertencia: 'alert-triangle', elogio: 'thumb-up', suspensao: 'player-pause', desligamento: 'user-x' });

const errorText = (error) => error?.details?.errors?._ ?? Object.values(error?.details?.errors ?? {})[0] ?? error?.message ?? 'Algo deu errado.';
/** Data sem hora (AAAA-MM-DD) como dd/mm/aaaa, sem passar por fuso (senão vira o dia anterior). */
const dateOnly = (s) => (s ? `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}` : '–');
/** dd/mm de um instante, no horário de Brasília. */
const ddmm = (iso) => new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', timeZone: 'America/Sao_Paulo' });
const fmt = (n) => (n == null ? '–' : Number(n).toFixed(1).replace('.', ','));
const todayIso = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
const daysAgoIso = (d) => new Date(Date.now() - 3 * 3600_000 - d * 86400_000).toISOString().slice(0, 10);
const within = (iso, days) => !Number(days) || Date.parse(iso) >= Date.now() - Number(days) * 86400_000;
const options = (pairs, value) => pairs.map(([v, t]) => h('option', { value: v, selected: String(v) === String(value) ? true : null }, t));

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...children) => {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
};

/** Avatar pequeno da tabela: foto do Discord (se houver) ou iniciais. */
function miniAvatar(m) {
  const initials = h('span', { class: 'dir-avatar dir-avatar--initials', 'aria-hidden': 'true' }, initialsOf(m.display_name));
  const url = safeAvatar(m.avatar_url);
  if (!url) return initials;
  const img = h('img', { class: 'dir-avatar', src: url, alt: '', width: 28, height: 28, referrerpolicy: 'no-referrer' });
  img.addEventListener('error', () => img.replaceWith(initials));
  return img;
}

/** Barra de score (0 a 10): verde acima de 7, amarela de 4 a 7, vermelha abaixo de 4. */
function scoreBar(score) {
  if (score == null) return h('span', { class: 'dir-muted' }, 'Sem avaliação');
  const bar = h('span', { class: 'dir-score-fill' });
  bar.style.width = `${Math.max(0, Math.min(10, score)) * 10}%`;
  return h('span', { class: 'dir-score', dataset: { tone: scoreTone(score) }, title: `Média das últimas 3 avaliações: ${fmt(score)}` },
    h('span', { class: 'dir-score-track', 'aria-hidden': 'true' }, bar), h('span', { class: 'dir-score-value' }, fmt(score)));
}

/* ------------------------------------------------------------------ gráficos (SVG) */

/** Radar: uma forma por série (até 5), eixos = as cinco notas. */
function radarChart(series, axes) {
  const S = 260;
  const c = S / 2;
  const R = 92;
  const point = (i, v) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / axes.length;
    return [c + Math.cos(a) * R * (v / 10), c + Math.sin(a) * R * (v / 10)];
  };
  const rings = [2.5, 5, 7.5, 10].map((v) => svg('polygon', { class: 'dir-grid', points: axes.map((_, i) => point(i, v).join(',')).join(' ') }));
  const spokes = axes.map((_, i) => svg('line', { class: 'dir-grid', x1: c, y1: c, x2: point(i, 10)[0], y2: point(i, 10)[1] }));
  const labels = axes.map((t, i) => {
    const [x, y] = point(i, 12.3);
    return svg('text', { class: 'dir-axis-label', x, y, 'text-anchor': Math.abs(x - c) < 4 ? 'middle' : x > c ? 'start' : 'end', 'dominant-baseline': 'middle' }, t);
  });
  const shapes = series.slice(0, SERIES).map((s, k) => svg('polygon', {
    class: `dir-radar dir-s${k + 1}`, points: s.values.map((v, i) => point(i, v).join(',')).join(' '),
  }, svg('title', {}, `${s.label}: ${s.values.map((v, i) => `${axes[i]} ${fmt(v)}`).join(', ')}`)));
  return h('figure', { class: 'dir-chart dir-chart--radar' },
    svg('svg', { viewBox: `-70 -10 ${S + 140} ${S + 20}`, role: 'img', 'aria-label': `Média das notas por cargo: ${series.map((s) => s.label).join(', ')}` },
      rings, spokes, shapes, labels),
    legend(series.slice(0, SERIES).map((s) => `${s.label} (${s.n})`)));
}

function legend(labels) {
  return h('figcaption', { class: 'dir-legend' }, labels.map((t, k) => h('span', { class: 'dir-legend-item' },
    h('span', { class: `dir-dot dir-s${(k % SERIES) + 1}`, 'aria-hidden': 'true' }), t)));
}

/** Barras verticais simples (distribuição de notas). */
function columnChart(values, labels, label) {
  const max = Math.max(1, ...values);
  const W = 60;
  const H = 120;
  const bars = values.map((v, i) => {
    const bh = v ? Math.max(3, Math.round((v / max) * H)) : 0;
    return svg('g', {},
      svg('rect', { class: 'dir-bar dir-s1', x: i * W + 12, y: H - bh, width: W - 24, height: bh, rx: 2 }, svg('title', {}, `${labels[i]}: ${v}`)),
      svg('text', { class: 'dir-bar-value', x: i * W + W / 2, y: H - bh - 4, 'text-anchor': 'middle' }, String(v)));
  });
  return h('figure', { class: 'dir-chart' },
    svg('svg', { viewBox: `0 -16 ${values.length * W} ${H + 16}`, role: 'img', 'aria-label': `${label}: ${values.map((v, i) => `${labels[i]} ${v}`).join(', ')}` },
      svg('line', { class: 'dir-grid', x1: 0, y1: H, x2: values.length * W, y2: H }), bars),
    h('div', { class: 'dir-axis', 'aria-hidden': 'true' }, labels.map((t) => h('span', {}, t))));
}

/** Linha no tempo (evolução de um membro; atividade por semana). */
function lineChart(points, { label, max = null, suffix = '' }) {
  const n = points.length;
  const W = 640;
  const H = 140;
  const top = max ?? Math.max(1, ...points.map((p) => p.value));
  const x = (i) => (n === 1 ? W / 2 : 16 + (i * (W - 32)) / (n - 1));
  const y = (v) => H - 8 - (v / top) * (H - 24);
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  return h('figure', { class: 'dir-chart' },
    svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${label}: ${points.map((p) => `${p.label} ${p.value}${suffix}`).join(', ')}` },
      svg('line', { class: 'dir-grid', x1: 0, y1: H - 8, x2: W, y2: H - 8 }),
      n > 1 && svg('path', { class: 'dir-line dir-s1', d: path }),
      points.map((p, i) => svg('circle', { class: 'dir-point dir-s1', cx: x(i), cy: y(p.value), r: 4 }, svg('title', {}, `${p.label}: ${p.value}${suffix}`)))),
    h('div', { class: 'dir-axis', 'aria-hidden': 'true' }, points.map((p) => h('span', {}, p.label))));
}

/** Rosca: fatias por tipo de atividade. */
function donutChart(parts) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const R = 52;
  const C = 2 * Math.PI * R;
  let offset = 0;
  const slices = parts.map((p, k) => {
    const len = total ? (p.value / total) * C : 0;
    const el = svg('circle', {
      class: `dir-slice dir-s${(k % SERIES) + 1}`, cx: 70, cy: 70, r: R, 'stroke-dasharray': `${len.toFixed(2)} ${(C - len).toFixed(2)}`,
      'stroke-dashoffset': (-offset).toFixed(2), transform: 'rotate(-90 70 70)',
    }, svg('title', {}, `${p.label}: ${p.value}`));
    offset += len;
    return el;
  });
  return h('figure', { class: 'dir-chart dir-chart--donut' },
    svg('svg', { viewBox: '0 0 140 140', role: 'img', 'aria-label': `Tipos de atividade: ${parts.map((p) => `${p.label} ${p.value}`).join(', ')}` },
      svg('circle', { class: 'dir-grid', cx: 70, cy: 70, r: R, fill: 'none' }), slices,
      svg('text', { class: 'dir-donut-total', x: 70, y: 70, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, String(total))),
    legend(parts.map((p) => `${p.label} (${p.value})`)));
}

/* ------------------------------------------------------------------ tela */

export function renderDiretoria(app, slug = null, memberId = null) {
  if (!app.feature('diretoria')) {
    restricted(app, 'Painel indisponível', 'O Painel da Diretoria ainda não foi instalado no banco de dados.');
    return null;
  }
  // O que cada pessoa abre (as abas sem permissão nem aparecem; o banco recusa do mesmo jeito).
  const access = {
    full: app.can('diretoria.ver'),
    areas: app.feature('avaliacoes_area') && (app.can('diretoria.ver') || app.can('diretoria.avaliacoes')),
    team: app.feature('avaliacoes') && (app.can('avaliacoes.criar') || app.can('avaliacoes.ler') || app.can('avaliacoes.gerenciar')),
    align: app.feature('alinhamento') && app.can('alinhamento.chamar'),
  };
  access.evals = access.full || (access.areas && app.can('diretoria.avaliacoes'));
  // Plano 12: a aba Decisões lê as avaliações do Head Staff (avaliacoes.ler); registrar a decisão exige o SQL 23.
  access.decisions = access.full && app.feature('avaliacoes') && app.can('avaliacoes.ler');
  access.decide = access.decisions && app.feature('avaliacoes_decisoes');
  const visibleTabs = TABS.filter(([key]) => (key === 'avaliacoes' ? access.evals : key === 'alinhamentos' ? access.align
    : key === 'decisoes' ? access.decisions : access.full));
  if (!visibleTabs.length) {
    restricted(app, 'Acesso restrito', 'O Painel da Diretoria é exclusivo de Resp. Equipe, Administrador e CEO.');
    return null;
  }

  const me = app.state.staff;
  let alive = true;
  const drafts = new Set();
  const ctx = {
    tab: visibleTabs.some(([key]) => key === slug) ? slug : visibleTabs[0][0], members: [], membersAt: 0, evaluations: [], occurrences: [], roleHistory: [], grid: null, rules: null,
    team: { q: '', role: '', area: '', status: 'ativos', sort: 'cargo', dir: -1 },
    evals: { days: '90', avaliador: '', member: '', view: '', areaDays: '90' },
    align: { page: 0, preset: null },
    dec: { member: memberId ?? '', data: null },
    prod: { days: '56', role: '', area: '', rows: null, key: '' },
    occ: { tipo: '', membro: '', days: '0' },
    hist: { member: '', page: 0, data: null },
  };

  const kpis = h('section', { class: 'dir-kpis', id: 'dir-kpis', 'aria-label': 'Indicadores' });
  const tabs = h('div', { class: 'dir-tabs', role: 'tablist', 'aria-label': 'Seções do painel' });
  const panel = h('div', { class: 'dir-panel', id: 'dir-panel', role: 'tabpanel' }, h('p', { class: 'panel-text' }, 'Carregando…'));
  const viewerAvatar = (() => {
    const url = safeAvatar(app.state.session?.user?.avatar_url);
    const initials = h('span', { class: 'dir-avatar dir-avatar--lg dir-avatar--initials', 'aria-hidden': 'true' }, initialsOf(me.display_name));
    if (!url) return initials;
    const img = h('img', { class: 'dir-avatar dir-avatar--lg', src: url, alt: '', width: 40, height: 40, referrerpolicy: 'no-referrer' });
    img.addEventListener('error', () => img.replaceWith(initials));
    return img;
  })();

  app.els.main.replaceChildren(h('div', { class: 'main-inner dir-page' },
    h('a', { class: 'back', href: '#/painel' }, icon('arrow-left'), 'Início'),
    h('header', { class: 'dir-head' },
      h('div', { class: 'dir-head-text' },
        h('h1', { class: 'page-title', tabindex: '-1' }, 'Painel da Diretoria'),
        h('p', { class: 'page-sub' }, 'Visão da equipe inteira: avaliações, produtividade, ocorrências e cargos.')),
      h('div', { class: 'dir-viewer' }, roleBadge(me.role), viewerAvatar)),
    kpis, tabs, panel));

  const nameOf = (id) => ctx.members.find((m) => m.discord_id === id)?.display_name ?? id;
  const memberOf = (id) => ctx.members.find((m) => m.discord_id === id) ?? null;
  const targets = () => ctx.members.filter((m) => m.active && canTarget(me, m)).sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'));
  const failed = (res, fallback) => { if (!res.error) return false; app.reportError(res.error, fallback); return true; };
  const profileLink = (id, text, attrs = {}) => (app.feature('perfil')
    ? h('a', { href: `#/perfil/${id}`, ...attrs }, text) : h('span', {}, text));

  /* ---------- dados ---------- */
  async function loadAllHistory() {
    const items = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const r = await app.adapter.listRoleHistory({ limit: 100, offset });
      if (r.error) return r;
      items.push(...r.data.items);
      if (items.length >= r.data.total || !r.data.items.length) break;
    }
    return { data: items, error: null };
  }

  async function loadMembers(force = false) {
    if (!force && ctx.membersAt && Date.now() - ctx.membersAt < CACHE_MS) return true;
    const r = await app.adapter.getDiretoriaMembers();
    if (!alive || failed(r, 'Não foi possível carregar a equipe.')) return false;
    ctx.members = r.data;
    ctx.membersAt = Date.now();
    return true;
  }

  async function load() {
    if (!access.full) {
      // Só as abas Avaliações e/ou Alinhamentos: nada da equipe inteira é lido.
      kpis.hidden = true;
      drawTabs();
      drawPanel();
      return;
    }
    const [ok, ev, oc, hist] = await Promise.all([
      loadMembers(true), app.adapter.listDirectorEvaluations(), app.adapter.listOccurrences(), loadAllHistory(),
    ]);
    if (!alive || !ok) return;
    if (failed(ev, 'Não foi possível carregar as avaliações.') || failed(oc, 'Não foi possível carregar as ocorrências.')
      || failed(hist, 'Não foi possível carregar o histórico de cargos.')) return;
    ctx.evaluations = ev.data;
    ctx.occurrences = oc.data;
    ctx.roleHistory = hist.data;
    drawKpis();
    drawTabs();
    drawPanel();
  }

  /** Depois de gravar algo: relê só o que mudou e redesenha. */
  async function refresh({ members = false, evaluations = false, occurrences = false, history = false } = {}) {
    const jobs = [];
    if (members) jobs.push(loadMembers(true));
    if (evaluations) jobs.push(app.adapter.listDirectorEvaluations().then((r) => { if (!r.error) ctx.evaluations = r.data; }));
    if (occurrences) jobs.push(app.adapter.listOccurrences().then((r) => { if (!r.error) ctx.occurrences = r.data; }));
    if (history) jobs.push(loadAllHistory().then((r) => { if (!r.error) ctx.roleHistory = r.data; ctx.hist.data = null; }));
    await Promise.all(jobs);
    if (!alive) return;
    ctx.prod.rows = null;
    drawKpis();
    drawPanel();
  }

  /* ---------- indicadores ---------- */
  function drawKpis() {
    const k = dashboardKpis({ members: ctx.members, evaluations: ctx.evaluations, occurrences: ctx.occurrences, roleHistory: ctx.roleHistory });
    const trendEl = (t) => {
      if (t === undefined) return null;
      if (t === null) return h('span', { class: 'dir-trend dir-trend--up' }, '↑ nenhum no mês anterior');
      if (t === 0) return h('span', { class: 'dir-trend' }, '= igual ao mês anterior');
      return h('span', { class: `dir-trend dir-trend--${t > 0 ? 'up' : 'down'}` }, `${t > 0 ? '↑' : '↓'} ${Math.abs(t)}% vs. mês anterior`);
    };
    const card = (key, label, v, sub) => h('div', { class: 'dir-kpi', dataset: { kpi: key } },
      h('span', { class: 'dir-kpi-value' }, String(v.value)),
      h('span', { class: 'dir-kpi-label' }, label),
      trendEl(v.trend) ?? h('span', { class: 'dir-trend' }, sub));
    kpis.replaceChildren(
      card('total', 'Total da staff', { value: k.total.value }, k.total.novos ? `+${k.total.novos} ${k.total.novos === 1 ? 'entrou' : 'entraram'} este mês` : 'ninguém entrou este mês'),
      card('sem-area', 'Sem área', k.semArea, 'ativos sem nenhuma área'),
      card('pendentes', 'Avaliações pendentes', k.pendentes, 'sem avaliação há 30 dias'),
      card('ocorrencias', 'Ocorrências no mês', k.ocorrencias, ''),
      card('promocoes', 'Promoções no mês', k.promocoes, ''));
  }

  /* ---------- abas ---------- */
  function drawTabs() {
    tabs.replaceChildren(...visibleTabs.map(([key, label]) => h('button', {
      type: 'button', class: 'dir-tab', role: 'tab', id: `dir-tab-${key}`, 'aria-selected': String(ctx.tab === key), 'aria-controls': 'dir-panel',
      onclick: () => { ctx.tab = key; drawTabs(); drawPanel(); },
    }, label)));
    panel.setAttribute('aria-labelledby', `dir-tab-${ctx.tab}`);
  }

  function drawPanel() {
    stopTeamEvaluations();
    ({
      equipe: drawTeam, avaliacoes: drawEvaluations, decisoes: drawDecisions, produtividade: drawProductivity, ocorrencias: drawOccurrences, cargos: drawRoles,
      alinhamentos: drawAlignments,
    })[ctx.tab]();
  }

  const section = (id, title, ico, ...children) => h('section', { class: 'panel dir-section', 'aria-labelledby': id },
    h('h2', { class: 'block-title', id }, icon(ico), title), ...children);
  const filter = (label, control) => h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label), control);
  const table = (id, caption, head, rows, empty = 'Nada para mostrar.') => h('div', { class: 'table-wrap' },
    h('table', { class: 'dir-table', id },
      h('caption', { class: 'sr-only' }, caption),
      h('thead', {}, h('tr', {}, head)),
      h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: head.length }, empty)))));

  /* ================================================================ Equipe */
  function teamRows() {
    const f = ctx.team;
    const q = f.q.trim().toLocaleLowerCase('pt-BR');
    const list = ctx.members.filter((m) => (f.status === 'todos' || (f.status === 'ativos') === m.active)
      && (!f.role || m.role === f.role)
      && (!f.area || (f.area === '-' ? !m.areas.length : m.areas.some((a) => a.nome === f.area)))
      && (!q || m.display_name.toLocaleLowerCase('pt-BR').includes(q) || m.discord_id.includes(q)));
    const key = {
      nome: (m) => m.display_name.toLocaleLowerCase('pt-BR'), cargo: (m) => roleLevel(m.role), score: (m) => m.media ?? -1,
      desde: (m) => m.cargo_desde ?? '',
    }[f.sort];
    return list.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * f.dir || a.display_name.localeCompare(b.display_name, 'pt-BR');
    });
  }

  function drawTeam() {
    const f = ctx.team;
    const body = h('div', { id: 'dir-team-body' });
    const areaNames = [...new Set(ctx.members.flatMap((m) => m.areas.map((a) => a.nome)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const search = h('input', { class: 'input input--sm', type: 'search', id: 'dir-team-q', value: f.q, placeholder: 'Nome ou Discord ID', autocomplete: 'off' });
    const typed = debounce((v) => { f.q = v; drawTeamTable(body); }, 300);
    search.addEventListener('input', () => typed(search.value));
    const sel = (id, value, pairs, key) => h('select', { class: 'input input--sm', id, onchange: (e) => { f[key] = e.target.value; drawTeamTable(body); } }, options(pairs, value));
    panel.replaceChildren(
      h('div', { class: 'staff-filters dir-filters' },
        filter('Buscar', search),
        filter('Cargo', sel('dir-team-role', f.role, [['', 'Todos'], ...[...ROLE_LIST].reverse().map((r) => [r.code, r.label])], 'role')),
        filter('Área', sel('dir-team-area', f.area, [['', 'Todas'], ['-', 'Sem área'], ...areaNames.map((n) => [n, n])], 'area')),
        filter('Situação', sel('dir-team-status', f.status, [['ativos', 'Ativos'], ['inativos', 'Inativos'], ['todos', 'Todos']], 'status'))),
      body);
    drawTeamTable(body);
  }

  function drawTeamTable(body) {
    const f = ctx.team;
    const rows = teamRows();
    const th = (key, label, cls) => {
      const sorted = f.sort === key;
      return h('th', { scope: 'col', class: cls, 'aria-sort': sorted ? (f.dir > 0 ? 'ascending' : 'descending') : null },
        h('button', {
          type: 'button', class: 'dir-sort', dataset: { sort: key },
          onclick: () => { f.dir = f.sort === key ? -f.dir : (key === 'nome' ? 1 : -1); f.sort = key; drawTeamTable(body); },
        }, label, sorted ? (f.dir > 0 ? ' ▲' : ' ▼') : ''));
    };
    const head = [th('nome', 'Membro'), th('cargo', 'Cargo'), h('th', { scope: 'col', class: 'dir-col-opt' }, 'Áreas'),
      th('score', 'Score', 'dir-col-opt'), th('desde', 'No cargo desde'), h('th', { scope: 'col' }, 'Ações')];
    const actions = (m) => {
      const target = canTarget(me, m);
      const manage = app.can('equipe.gerenciar') && m.discord_id !== me.discord_id && canManageRole(me.role, m.role) && assignableRoles(me.role).length > 1;
      const btn = (ico, label, onclick, key) => h('button', {
        type: 'button', class: 'icon-btn icon-btn--sm', 'aria-label': `${label}: ${m.display_name}`, title: label, dataset: { action: key }, onclick,
      }, icon(ico));
      return h('div', { class: 'dir-actions' },
        app.feature('perfil') && h('a', { class: 'icon-btn icon-btn--sm', href: `#/perfil/${m.discord_id}`, 'aria-label': `Ver perfil: ${m.display_name}`, title: 'Ver perfil', dataset: { action: 'perfil' } }, icon('user-circle')),
        target && btn('star', 'Avaliar', () => evaluationDialog(m.discord_id), 'avaliar'),
        target && btn('alert-triangle', 'Registrar ocorrência', () => occurrenceDialog(m.discord_id), 'ocorrencia'),
        manage && m.active && btn('arrows-up-down', 'Alterar cargo', () => roleDialog(m), 'cargo'));
    };
    const tr = (m) => h('tr', { class: !m.areas.length && m.active ? 'dir-row--noarea' : null, dataset: { member: m.discord_id } },
      h('td', {}, h('span', { class: 'dir-member' }, miniAvatar(m), h('span', {}, m.display_name,
        !m.active && h('span', { class: 'badge badge--revisar dir-inline-badge' }, 'Inativo')))),
      h('td', {}, roleBadge(m.role)),
      h('td', { class: 'dir-col-opt' }, m.areas.length
        ? h('span', { class: 'dir-areas' }, m.areas.map((a) => h('span', { class: 'dir-area-chip' }, a.nome)))
        : h('span', { class: 'dir-noarea' }, '⚠ Sem área')),
      h('td', { class: 'dir-col-opt' }, scoreBar(m.media)),
      h('td', {}, m.cargo_desde ? formatDate(m.cargo_desde) : '–'),
      h('td', {}, actions(m)));
    body.replaceChildren(
      h('p', { class: 'dir-count', 'aria-live': 'polite' }, `${rows.length} ${rows.length === 1 ? 'membro' : 'membros'}`),
      table('dir-team-table', 'Equipe da staff', head, rows.map(tr), 'Ninguém com esses filtros.'));
  }

  /* ================================================================ Avaliações */
  /* Plano 11: a aba Avaliações junta as da Diretoria (0 a 10), as médias por área e as do Head Staff (página #/avaliacoes-equipe). */
  const EVAL_VIEWS = [
    ['diretoria', 'Avaliações da Diretoria', access.full],
    ['areas', 'Por área', access.areas],
    ['equipe', 'Avaliações do Head Staff', access.team],
  ].filter((v) => v[2]);
  let teamCleanup = null;
  let areaToken = 0;
  function stopTeamEvaluations() {
    teamCleanup?.();
    teamCleanup = null;
  }

  function drawEvaluations() {
    stopTeamEvaluations();
    const f = ctx.evals;
    if (!EVAL_VIEWS.some(([key]) => key === f.view)) f.view = EVAL_VIEWS[0]?.[0] ?? '';
    const box = h('div', { id: 'dir-eval-body' });
    const views = EVAL_VIEWS.length > 1 && h('div', { class: 'dir-subtabs', role: 'group', 'aria-label': 'Tipo de avaliação', id: 'dir-eval-views' },
      EVAL_VIEWS.map(([key, label]) => h('button', {
        type: 'button', class: 'btn btn--sm dir-subtab', id: `dir-eval-view-${key}`, 'aria-pressed': String(f.view === key),
        onclick: () => { f.view = key; drawEvaluations(); },
      }, label)));
    panel.replaceChildren(...[views, box].filter(Boolean));
    if (f.view === 'diretoria') drawDirectorEvaluations(box);
    else if (f.view === 'areas') drawByArea(box);
    else if (f.view === 'equipe') teamCleanup = mountTeamEvaluations(app, box);
    else box.replaceChildren(h('p', { class: 'panel-text' }, 'Nenhuma avaliação disponível para o seu cargo.'));
  }

  async function drawByArea(box) {
    const f = ctx.evals;
    const token = ++areaToken;
    box.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
    const r = await app.adapter.getEvaluationsByArea({ days: f.areaDays });
    if (!alive || token !== areaToken || !box.isConnected) return;
    if (failed(r, 'Não foi possível carregar as médias por área.')) { box.replaceChildren(); return; }
    const rows = r.data;
    const rated = rows.filter((x) => x.avaliacoes > 0);
    const dot = (cor) => {
      const el = h('span', { class: 'dir-area-dot', 'aria-hidden': 'true' });
      if (/^#[0-9a-fA-F]{6}$/.test(cor ?? '')) el.style.background = cor;
      return el;
    };
    box.replaceChildren(
      h('div', { class: 'dir-toolbar' },
        h('div', { class: 'staff-filters dir-filters' },
          filter('Período', h('select', { class: 'input input--sm', id: 'dir-area-days', onchange: (e) => { f.areaDays = e.target.value; drawByArea(box); } },
            options(Object.entries(PERIODS), f.areaDays))))),
      section('dir-area-chart-title', 'Nota geral por área', 'chart-bar',
        h('p', { class: 'panel-text' }, 'Média das avaliações da Diretoria (0 a 10). A avaliação conta na área escolhida nela; sem área escolhida, nas áreas em que o membro está hoje.'),
        rated.length
          ? h('ul', { class: 'dir-area-bars', id: 'dir-area-bars' }, rated.map((x) => h('li', { class: 'dir-area-bar' },
            h('span', { class: 'dir-area-name' }, dot(x.cor), x.area_nome), scoreBar(x.nota_geral))))
          : h('p', { class: 'panel-text' }, 'Sem avaliações no período.')),
      section('dir-area-table-title', 'Médias por área', 'list-details',
        table('dir-area-table', 'Médias das avaliações por área',
          ['Área', 'Avaliados', 'Avaliações', ...SCORE_FIELDS.map((x) => x.label)].map((t) => h('th', { scope: 'col' }, t)),
          rows.map((x) => h('tr', {},
            h('td', {}, dot(x.cor), x.area_nome, x.status === 'arquivada' ? ' (arquivada)' : ''),
            h('td', {}, String(x.avaliados)), h('td', {}, String(x.avaliacoes)),
            ...SCORE_FIELDS.map((k) => h('td', {}, fmt(x[k.key]))))), 'Nenhuma área cadastrada.')));
  }

  function drawDirectorEvaluations(box) {
    const f = ctx.evals;
    const list = ctx.evaluations.filter((e) => within(e.criado_em, f.days) && (!f.avaliador || e.avaliador_id === f.avaliador));
    const evaluators = [...new Set(ctx.evaluations.map((e) => e.avaliador_id))].map((id) => [id, nameOf(id)]).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
    const pending = pendingEvaluation(ctx.members, ctx.evaluations).filter((m) => canTarget(me, m));
    const roleSeries = averagesByRole(list, (id) => memberOf(id)?.role).map((s) => ({ ...s, label: roleLabel(s.role) }));
    const evolutionBox = h('div', { id: 'dir-evolution' });
    const evaluated = [...new Set(ctx.evaluations.map((e) => e.avaliado_id))].map((id) => [id, nameOf(id)]).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
    if (!f.member || !evaluated.some(([id]) => id === f.member)) f.member = evaluated[0]?.[0] ?? '';
    const drawEvolution = () => {
      const mine = ctx.evaluations.filter((e) => e.avaliado_id === f.member).sort((a, b) => a.criado_em.localeCompare(b.criado_em)).slice(-12);
      evolutionBox.replaceChildren(mine.length
        ? lineChart(mine.map((e) => ({ label: ddmm(e.criado_em), value: e.nota_geral })), { label: `Evolução de ${nameOf(f.member)}`, max: 10 })
        : h('p', { class: 'panel-text' }, 'Nenhuma avaliação ainda.'));
    };
    drawEvolution();
    const sel = (id, value, pairs, onchange) => h('select', { class: 'input input--sm', id, onchange }, options(pairs, value));

    box.replaceChildren(
      h('div', { class: 'dir-toolbar' },
        h('div', { class: 'staff-filters dir-filters' },
          filter('Período', sel('dir-eval-days', f.days, Object.entries(PERIODS), (e) => { f.days = e.target.value; drawEvaluations(); })),
          filter('Avaliador', sel('dir-eval-by', f.avaliador, [['', 'Todos'], ...evaluators], (e) => { f.avaliador = e.target.value; drawEvaluations(); }))),
        h('button', { type: 'button', class: 'btn btn--primary', id: 'dir-new-eval', onclick: () => evaluationDialog('') }, icon('plus'), 'Nova avaliação')),
      section('dir-pending-title', 'Precisam de avaliação', 'clock-exclamation',
        h('p', { class: 'panel-text' }, 'Membros ativos sem avaliação da Diretoria nos últimos 30 dias. Clique no nome para avaliar.'),
        pending.length
          ? h('ul', { class: 'dir-pending', id: 'dir-pending' }, pending.map((m) => h('li', {},
            h('button', { type: 'button', class: 'dir-pending-btn', onclick: () => evaluationDialog(m.discord_id) },
              h('span', { class: 'badge dir-badge-warn' }, 'Pendente'), m.display_name, ' ', roleBadge(m.role)))))
          : h('p', { class: 'panel-text' }, '✓ Todos os membros que você pode avaliar estão em dia.')),
      h('div', { class: 'dir-grid-2' },
        section('dir-radar-title', 'Média por cargo', 'chart-radar',
          roleSeries.length ? radarChart(roleSeries, SCORE_FIELDS.map((s) => s.label)) : h('p', { class: 'panel-text' }, 'Sem avaliações no período.')),
        section('dir-dist-title', 'Distribuição da nota geral', 'chart-bar',
          list.length ? columnChart(scoreDistribution(list), ['0-2', '2-4', '4-6', '6-8', '8-10'], 'Avaliações por faixa de nota geral')
            : h('p', { class: 'panel-text' }, 'Sem avaliações no período.'))),
      section('dir-evo-title', 'Evolução de um membro', 'chart-line',
        evaluated.length ? filter('Membro', sel('dir-evo-member', f.member, evaluated, (e) => { f.member = e.target.value; drawEvolution(); })) : null,
        evolutionBox),
      section('dir-evals-title', 'Avaliações registradas', 'list-details',
        table('dir-evals-table', 'Avaliações registradas',
          ['Avaliado', 'Avaliador', 'Período', 'Geral', 'Média', 'Visível ao avaliado', 'Registrada em'].map((t) => h('th', { scope: 'col' }, t)),
          list.map((e) => h('tr', {},
            h('td', {}, profileLink(e.avaliado_id, e.avaliado_nome ?? nameOf(e.avaliado_id)), e.comentario && h('span', { class: 'dir-comment' }, e.comentario)),
            h('td', {}, e.avaliador_nome ?? nameOf(e.avaliador_id)),
            h('td', {}, `${dateOnly(e.periodo_inicio)} a ${dateOnly(e.periodo_fim)}`),
            h('td', {}, scoreBar(e.nota_geral)),
            h('td', {}, fmt(scoreAverage(e))),
            h('td', {}, e.visivel_avaliado ? '✓ Sim' : '✗ Não'),
            h('td', {}, formatDate(e.criado_em, { time: true })))), 'Nenhuma avaliação no período.')));
  }

  /* ================================================================ Decisões (plano 12) */
  const canManage = (m) => app.can('equipe.gerenciar') && m.discord_id !== me.discord_id && canManageRole(me.role, m.role) && assignableRoles(me.role).length > 1;
  const nextRole = (role) => ROLE_LIST.find((r) => r.level === roleLevel(role) + 1)?.code ?? null;
  const daysSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400_000)) : null);
  let decToken = 0;

  async function loadDecisionData(force = false) {
    if (ctx.dec.data && !force) return true;
    const token = ++decToken;
    const to = new Date(Date.now() + 86400_000);
    const [periods, evals, decs, act] = await Promise.all([
      app.adapter.listEvaluationPeriods(), app.adapter.listEvaluations(),
      access.decide ? app.adapter.listEvaluationDecisions() : Promise.resolve({ data: [], error: null }),
      app.adapter.getDiretoriaActivity({ from: new Date(to.getTime() - 57 * 86400_000).toISOString(), to: to.toISOString() }),
    ]);
    if (!alive || token !== decToken) return false;
    if (failed(periods, 'Não foi possível carregar os períodos.') || failed(evals, 'Não foi possível carregar as avaliações.')) return false;
    const current = periods.data.find((x) => isPeriodOpen(x)) ?? null;
    const cov = current && access.decide ? await app.adapter.getEvaluationCoverage(current.id) : null;
    if (!alive || token !== decToken) return false;
    ctx.dec.data = {
      periods: periods.data, current, coverage: cov && !cov.error ? cov.data : null,
      evaluations: evals.data.filter((e) => e.status !== 'rascunho' && e.evaluated_id !== me.discord_id),
      decisions: decs.error ? [] : decs.data, activity: act.error ? [] : act.data,
    };
    return true;
  }

  async function drawDecisions() {
    if (!ctx.dec.data) {
      panel.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
      if (!(await loadDecisionData()) || ctx.tab !== 'decisoes') return;
    }
    const d = ctx.dec.data;
    const pending = access.decide ? pendingDecisions(d.evaluations, d.decisions) : [];
    const cov = d.current ? periodCoverage({ period: d.current, evaluations: d.evaluations, staff: ctx.members, evaluators: d.coverage ?? [] }) : null;
    const evaluated = [...new Set(d.evaluations.map((e) => e.evaluated_id))];
    const people = ctx.members.filter((m) => evaluated.includes(m.discord_id) || (m.active && canTarget(me, m)))
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'));
    if (ctx.dec.member && !people.some((m) => m.discord_id === ctx.dec.member)) ctx.dec.member = '';
    const sheet = h('div', { id: 'dir-dec-sheet' });
    const kpi = (key, value, label) => h('div', { class: 'dir-kpi', dataset: { kpi: key } }, h('span', { class: 'dir-kpi-value' }, value), h('span', { class: 'dir-kpi-label' }, label));
    panel.replaceChildren(...[
      h('section', { class: 'dir-kpis dir-dec-kpis', id: 'dir-dec-kpis', 'aria-label': 'Indicadores das avaliações' },
        kpi('periodo', d.current ? cov.timeLeft : 'sem período', d.current ? `para fechar "${d.current.title}"` : 'nenhum período aberto'),
        kpi('avaliados', cov ? `${cov.evaluated} de ${cov.total}` : '–', 'avaliados no período'),
        kpi('parados', d.coverage ? String(cov.idleEvaluators.length) : '–', 'avaliadores sem enviar'),
        kpi('aguardando', access.decide ? String(pending.length) : '–', 'recomendações aguardando decisão')),
      !access.decide && h('p', { class: 'banner banner--info' }, icon('info-circle'),
        h('span', {}, 'Para registrar decisões, falta rodar o SQL 23 no banco. Por enquanto a ficha só mostra os dados.')),
      access.decide && section('dir-dec-pending-title', 'Aguardando decisão da Direção', 'gavel',
        pending.length
          ? h('ul', { class: 'dir-pending', id: 'dir-dec-pending' }, pending.map((e) => h('li', {},
            h('button', { type: 'button', class: 'dir-pending-btn', dataset: { member: e.evaluated_id }, onclick: () => { ctx.dec.member = e.evaluated_id; drawDecisions(); document.getElementById('dir-dec-sheet')?.scrollIntoView?.({ block: 'start' }); } },
              h('span', { class: `badge ${['advertencia', 'desligamento'].includes(e.recommendation) ? 'dir-badge-warn' : 'badge--status'}` }, recommendationLabel(e.recommendation)),
              e.evaluated_name ?? nameOf(e.evaluated_id), h('span', { class: 'dir-muted' }, ` · por ${e.evaluator_name ?? nameOf(e.evaluator_id)}, ${formatDate(e.submitted_at)}`)))))
          : h('p', { class: 'panel-text' }, '✓ Nenhuma recomendação esperando decisão.')),
      section('dir-dec-sheet-title', 'Ficha de decisão', 'id-badge-2',
        h('div', { class: 'staff-filters dir-filters' }, filter('Membro', h('select', {
          class: 'input input--sm', id: 'dir-dec-member', onchange: (e) => { ctx.dec.member = e.target.value; drawSheet(sheet); },
        }, options([['', 'Escolha um membro'], ...people.map((m) => [m.discord_id, `${m.display_name} (${roleLabel(m.role)})`])], ctx.dec.member)))),
        sheet)].filter(Boolean));
    drawSheet(sheet);
    app.applyOnline?.();
  }

  function drawSheet(box) {
    const d = ctx.dec.data;
    const m = memberOf(ctx.dec.member);
    if (!m) { box.replaceChildren(h('p', { class: 'panel-text' }, 'Escolha um membro para ver tudo sobre ele num lugar só.')); return; }
    const head = d.evaluations.filter((e) => e.evaluated_id === m.discord_id)
      .sort((a, b) => String(b.submitted_at).localeCompare(String(a.submitted_at)));
    const last = latestDecisions(d.decisions);
    const periodName = (id) => d.periods.find((x) => x.id === id)?.title ?? '';
    const director = ctx.evaluations.filter((e) => e.avaliado_id === m.discord_id).slice(0, 6);
    const occ = ctx.occurrences.filter((o) => o.membro_id === m.discord_id).slice(0, 6);
    const roles = ctx.roleHistory.filter((x) => x.membro_id === m.discord_id).slice(0, 6);
    const decs = d.decisions.filter((x) => x.evaluated_id === m.discord_id);
    const acts = d.activity.filter((r) => r.discord_id === m.discord_id);
    const byType = ACTIVITY_TYPES.map((t) => ({ label: t.label, n: acts.filter((r) => r.tipo === t.code).reduce((a, r) => a + r.total, 0) })).filter((x) => x.n);
    const evo = criterionEvolution(d.evaluations, d.periods, m.discord_id);
    const days = daysSince(m.cargo_desde);
    const target = canTarget(me, m);
    const btn = (id, ico, label, onclick) => h('button', { type: 'button', class: 'btn btn--sm', id, onclick }, icon(ico), label);
    const arrow = (t) => ({ sobe: h('span', { class: 'dir-up' }, '↑'), cai: h('span', { class: 'dir-down' }, '↓'), igual: h('span', { class: 'dir-muted' }, '=') })[t] ?? h('span', { class: 'dir-muted' }, '–');

    box.replaceChildren(...[
      h('div', { class: 'dir-dec-who', id: 'dir-dec-who' },
        miniAvatar(m),
        h('div', {},
          h('p', { class: 'dir-dec-name' }, profileLink(m.discord_id, m.display_name), ' ', roleBadge(m.role), !m.active && h('span', { class: 'badge badge--revisar dir-inline-badge' }, 'Inativo')),
          h('p', { class: 'dir-muted' }, m.cargo_desde ? `No cargo desde ${formatDate(m.cargo_desde)} (${days} ${days === 1 ? 'dia' : 'dias'})` : 'Sem data de entrada no cargo',
            m.areas.length ? ` · Áreas: ${m.areas.map((a) => a.nome).join(', ')}` : ' · Sem área'))),
      h('div', { class: 'dir-dec-actions', id: 'dir-dec-actions' },
        target && btn('dir-dec-avaliar', 'star', 'Avaliar (Diretoria)', () => evaluationDialog(m.discord_id)),
        target && btn('dir-dec-ocorrencia', 'alert-triangle', 'Registrar ocorrência', () => occurrenceDialog(m.discord_id)),
        canManage(m) && m.active && btn('dir-dec-cargo', 'arrows-up-down', 'Alterar cargo', () => roleDialog(m)),
        access.align && m.active && btn('dir-dec-alinhar', 'message-circle', 'Chamar para alinhamento', () => openAlignment(m, ''))),
      h('h3', { class: 'dir-dec-sub' }, 'Avaliações do Head Staff (notas de 1 a 5)'),
      head.length
        ? h('div', { class: 'dir-dec-cards', id: 'dir-dec-head' }, head.map((e) => {
          const dec = last.get(e.id);
          return h('article', { class: 'dir-dec-card', dataset: { evaluation: e.id } },
            h('p', { class: 'dir-dec-card-head' }, h('strong', {}, periodName(e.period_id) || 'Período'),
              h('span', { class: 'dir-muted' }, ` · por ${e.evaluator_name ?? nameOf(e.evaluator_id)}`), e.status === 'arquivada' && h('span', { class: 'dir-muted' }, ' · arquivada')),
            h('p', {}, h('span', { class: 'stars', 'aria-label': `Nota geral ${e.overall} de 5` }, stars(e.overall)), ' ',
              h('span', { class: `badge ${['advertencia', 'desligamento'].includes(e.recommendation) ? 'dir-badge-warn' : 'badge--status'}` }, recommendationLabel(e.recommendation) || 'Sem recomendação')),
            h('ul', { class: 'plain-list dir-dec-crit' }, (e.criteria ?? []).map((c) => h('li', {}, h('span', {}, c.label),
              h('span', { class: 'stars', 'aria-label': `${c.score ?? 'sem nota'} de 5` }, stars(c.score))))),
            e.justification && h('p', { class: 'dir-dec-just' }, h('strong', {}, 'Justificativa: '), e.justification),
            h('p', { class: 'dir-dec-status' }, dec ? `Direção: ${decisionLabel(dec.decision)}${dec.action ? ` (${recommendationLabel(dec.action)})` : ''} · ${dec.decided_by_name ?? nameOf(dec.decided_by)}, ${formatDate(dec.decided_at)}` : 'Aguardando decisão da Direção'),
            h('div', { class: 'dir-dec-card-actions' },
              h('a', { class: 'btn btn--sm btn--ghost', href: `#/avaliacoes-equipe/${e.id}` }, 'Ler tudo'),
              access.decide && e.recommendation && !decisionTargetError(me, m) && h('button', {
                type: 'button', class: 'btn btn--sm btn--primary', dataset: { action: 'decidir' }, 'data-requires-online': '', onclick: () => decisionDialog(e, m),
              }, icon('gavel'), dec && dec.decision !== 'adiada' ? 'Nova decisão' : 'Registrar decisão')));
        }))
        : h('p', { class: 'panel-text' }, 'Nenhuma avaliação do Head Staff sobre este membro.'),
      evo.periods.length > 1 && h('div', { class: 'dir-grid-2' },
        section('dir-dec-evo-title', 'Evolução da nota geral (Head Staff, 1 a 5)', 'chart-line',
          lineChart(evo.periods.map((x, i) => ({ label: x.title.slice(0, 12), value: evo.overall[i] ?? 0 })), { label: `Nota geral de ${m.display_name} por período`, max: 5 })),
        section('dir-dec-crit-title', 'Evolução por critério', 'list-details',
          table('dir-dec-crit-table', 'Média de cada critério por período',
            ['Critério', ...evo.periods.map((x) => x.title), 'Tendência'].map((t) => h('th', { scope: 'col' }, t)),
            evo.series.map((x) => h('tr', {}, h('td', {}, x.label), ...x.values.map((v) => h('td', {}, v == null ? '–' : fmt(v))), h('td', {}, arrow(criterionTrend(x.values)))))))),
      h('div', { class: 'dir-grid-2' },
        section('dir-dec-dir-title', 'Avaliações da Diretoria (notas de 0 a 10)', 'star',
          director.length
            ? h('ul', { class: 'plain-list dir-dec-list' }, director.map((e) => h('li', {}, scoreBar(e.nota_geral),
              h('span', { class: 'dir-muted' }, ` ${dateOnly(e.periodo_inicio)} a ${dateOnly(e.periodo_fim)} · ${e.avaliador_nome ?? nameOf(e.avaliador_id)}`))))
            : h('p', { class: 'panel-text' }, 'Nenhuma avaliação da Diretoria.')),
        section('dir-dec-prod-title', 'Produtividade (últimas 8 semanas)', 'chart-bar',
          byType.length
            ? h('ul', { class: 'plain-list dir-dec-list' }, byType.map((x) => h('li', {}, `${x.label}: ${x.n}`)))
            : h('p', { class: 'panel-text' }, 'Nenhuma atividade registrada no período.'))),
      h('div', { class: 'dir-grid-2' },
        section('dir-dec-occ-title', 'Ocorrências', 'alert-triangle',
          occ.length
            ? h('ul', { class: 'plain-list dir-dec-list' }, occ.map((o) => h('li', {}, h('strong', {}, occurrenceLabel(o.tipo)), ` · ${formatDate(o.feito_em)} · `, o.descricao)))
            : h('p', { class: 'panel-text' }, 'Nenhuma ocorrência.')),
        section('dir-dec-roles-title', 'Histórico de cargos', 'history',
          roles.length
            ? h('ul', { class: 'plain-list dir-dec-list' }, roles.map((x) => h('li', {}, roleBadge(x.cargo_anterior), ' › ', roleBadge(x.cargo_novo),
              h('span', { class: 'dir-muted' }, ` ${formatDate(x.feito_em)}${x.motivo ? ` · ${x.motivo}` : ''}`))))
            : h('p', { class: 'panel-text' }, 'Nenhuma troca de cargo registrada.'))),
      access.decide && section('dir-dec-hist-title', 'Decisões registradas', 'gavel',
        decs.length
          ? h('ol', { class: 'plain-list dir-dec-list', id: 'dir-dec-history' }, decs.map((x) => h('li', {},
            h('strong', {}, decisionLabel(x.decision)), x.action ? ` · ${recommendationLabel(x.action)}` : '',
            h('span', { class: 'dir-muted' }, ` · recomendação: ${recommendationLabel(x.recommendation) || '–'} · ${x.decided_by_name ?? nameOf(x.decided_by)}, ${formatDate(x.decided_at, { time: true })}`),
            h('p', { class: 'dir-comment' }, x.reason))))
          : h('p', { class: 'panel-text' }, 'Nenhuma decisão registrada sobre este membro.')),
    ].filter(Boolean));
    app.applyOnline?.();
  }

  function openAlignment(m, text) {
    ctx.align.preset = { membro_id: m.discord_id, mensagem: text };
    ctx.tab = 'alinhamentos';
    drawTabs();
    drawPanel();
  }

  /** Registra a decisão sobre uma avaliação do Head Staff e oferece a ação já preenchida (Decisão 3: nada automático). */
  async function decisionDialog(e, m) {
    const radios = h('div', { class: 'dir-al-deadlines', role: 'radiogroup', 'aria-labelledby': 'dir-dec-kind-label' },
      DECISIONS.map((x) => h('label', { class: 'dir-al-deadline' },
        h('input', { type: 'radio', name: 'dir-dec-kind', id: `dir-dec-kind-${x.code}`, value: x.code, checked: x.code === 'acatada' }), ' ', x.label)));
    const kindError = h('p', { class: 'field-error', hidden: true });
    const action = formField('dir-dec-action', 'O que a Direção decidiu fazer', h('select', { class: 'input' },
      options([['', 'Escolha'], ...RECOMMENDATIONS.filter((x) => x.code !== e.recommendation).map((x) => [x.code, x.label])], '')));
    const reason = formField('dir-dec-reason', 'Motivo', h('textarea', { class: 'input textarea', rows: 4, maxlength: DECISION_REASON.max }),
      `De ${DECISION_REASON.min} a ${DECISION_REASON.max} caracteres. Fica no histórico; o membro não vê.`);
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const kind = () => radios.querySelector('input:checked')?.value ?? '';
    const sync = () => { action.el.hidden = kind() !== 'outra'; };
    radios.addEventListener('change', sync);
    sync();
    const body = h('form', { class: 'dir-form', id: 'dir-dec-form', novalidate: true, onsubmit: (ev) => ev.preventDefault() },
      h('p', {}, `Recomendação do Head Staff para ${m.display_name}: `, h('strong', {}, recommendationLabel(e.recommendation)), '.'),
      h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'dir-dec-kind-label' }, 'Decisão'), radios, kindError),
      action.el, reason.el, general);
    const draft = attachFormDraft(app, `diretoria:decisao:${e.id}`, body, { bannerId: 'dir-dec-draft' });
    drafts.add(draft);
    const fields = { decision: { error: kindError }, action, reason };
    const input = () => ({ evaluation_id: e.id, recommendation: e.recommendation, decision: kind(), action: action.input.value, reason: reason.input.value });
    let saved = null;
    const done = await formDialog({
      title: 'Registrar decisão', body, confirmLabel: 'Registrar decisão', draft,
      validate: () => showErrors(fields, general, validateDecision(e, input()).errors),
      submit: async () => {
        const r = await app.adapter.registerEvaluationDecision(input());
        if (r.error) { showErrors(fields, general, r.error.details?.errors ?? { _: errorText(r.error) }); return r.error; }
        saved = r.data;
        return null;
      },
    });
    if (!done || !saved) return;
    toast(`Decisão registrada: ${decisionLabel(saved.decision)}.`);
    ctx.dec.data.decisions = [saved, ...ctx.dec.data.decisions];
    drawDecisions();
    // Decisão 3 do plano 12: a ação abre já preenchida, sempre com confirmação.
    const next = decisionFollowUp(resolvedAction(e, saved.decision, saved.action));
    if (!next) return;
    const allowed = next.kind === 'cargo' ? canManage(m) && m.active : next.kind === 'alinhamento' ? access.align && m.active : canTarget(me, m);
    if (!allowed) { toast(`Para ${next.label.toLowerCase()}, peça a quem tem a permissão.`, 4500); return; }
    const go = await openDialog({
      title: `${next.label} agora?`,
      body: h('p', {}, `A decisão foi registrada. Quer abrir "${next.label}" para ${m.display_name} com os dados já preenchidos? Nada é feito sem você confirmar na próxima janela.`),
      actions: [{ label: 'Depois', value: false, variant: 'ghost' }, { label: next.label, value: true, variant: 'primary', autofocus: true }],
    });
    if (!go || !alive) return;
    const text = followUpText(e, saved.reason);
    if (next.kind === 'cargo') await roleDialog(m, { role: nextRole(m.role), motivo: text });
    else if (next.kind === 'ocorrencia') await occurrenceDialog(m.discord_id, { tipo: next.tipo, descricao: text });
    else openAlignment(m, text);
  }

  /* ================================================================ Produtividade */
  async function drawProductivity() {
    const f = ctx.prod;
    const days = Math.max(56, Number(f.days));
    const key = `${days}`;
    if (!f.rows || f.key !== key) {
      panel.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
      const to = new Date(Date.now() + 86400_000);
      const r = await app.adapter.getDiretoriaActivity({ from: new Date(to.getTime() - (days + 1) * 86400_000).toISOString(), to: to.toISOString() });
      if (!alive || ctx.tab !== 'produtividade') return;
      if (r.error) { panel.replaceChildren(h('p', { class: 'field-error', role: 'alert' }, errorText(r.error))); return; }
      f.rows = r.data;
      f.key = key;
    }
    const since = weekOf(new Date(Date.now() - Number(f.days) * 86400_000).toISOString());
    const keep = (r) => {
      const m = memberOf(r.discord_id);
      return (!f.role || m?.role === f.role) && (!f.area || m?.areas.some((a) => a.nome === f.area));
    };
    const rows = f.rows.filter(keep);
    const inPeriod = rows.filter((r) => r.semana >= since);
    const ranking = productivityRanking(inPeriod);
    const weeks = lastWeeks(8);
    const weekly = weeklyTotals(rows, weeks);
    const byType = ACTIVITY_TYPES.map((t) => ({ label: t.label, value: inPeriod.filter((r) => r.tipo === t.code).reduce((a, r) => a + r.total, 0) }))
      .filter((p) => p.value > 0);
    const procs = ranking.map((r) => ({ id: r.discord_id, v: r.porTipo.procedimento ?? 0 })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v).slice(0, 10);
    const areaNames = [...new Set(ctx.members.flatMap((m) => m.areas.map((a) => a.nome)))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const sel = (id, value, pairs, k) => h('select', { class: 'input input--sm', id, onchange: (e) => { f[k] = e.target.value; drawProductivity(); } }, options(pairs, value));
    const csv = app.can('diretoria.gerenciar') && h('button', {
      type: 'button', class: 'btn', id: 'dir-csv', disabled: ranking.length ? null : true,
      onclick: () => downloadText(`produtividade-diretoria-${todayIso()}.csv`, String.fromCharCode(0xFEFF) + rankingCsv(ranking, nameOf), 'text/csv;charset=utf-8'),
    }, icon('file-spreadsheet'), 'Exportar CSV');

    panel.replaceChildren(
      h('div', { class: 'dir-toolbar' },
        h('div', { class: 'staff-filters dir-filters' },
          filter('Período', sel('dir-prod-days', f.days, Object.entries(PROD_PERIODS), 'days')),
          filter('Cargo', sel('dir-prod-role', f.role, [['', 'Todos'], ...[...ROLE_LIST].reverse().map((r) => [r.code, r.label])], 'role')),
          filter('Área', sel('dir-prod-area', f.area, [['', 'Todas'], ...areaNames.map((n) => [n, n])], 'area'))),
        csv),
      h('p', { class: 'panel-text dir-note' }, 'Conta o que já fica registrado no site: allowlists, entrevistas, procedimentos, reuniões, entradas em área, avaliações e ocorrências. Score de 0 a 10 em relação a quem mais pontuou no período. Contagem por semana (segunda a domingo, horário de Brasília).'),
      h('div', { class: 'dir-grid-2' },
        section('dir-week-title', 'Atividade da staff por semana', 'chart-line',
          lineChart(weekly.map((w) => ({ label: `${w.semana.slice(8, 10)}/${w.semana.slice(5, 7)}`, value: w.total })), { label: 'Atividades por semana nas últimas 8 semanas' })),
        section('dir-types-title', 'Tipos de atividade', 'chart-donut',
          byType.length ? donutChart(byType) : h('p', { class: 'panel-text' }, 'Nenhuma atividade no período.'))),
      section('dir-procs-title', 'Procedimentos criados (top 10)', 'file-text',
        procs.length ? h('ol', { class: 'dir-hbars', id: 'dir-procs' }, procs.map((x) => {
          const fill = h('span', { class: 'dir-hbar-fill dir-s1' });
          fill.style.width = `${(x.v / procs[0].v) * 100}%`;
          return h('li', { class: 'dir-hbar' }, h('span', { class: 'dir-hbar-label' }, nameOf(x.id)),
            h('span', { class: 'dir-hbar-track', 'aria-hidden': 'true' }, fill), h('span', { class: 'dir-hbar-value' }, String(x.v)));
        })) : h('p', { class: 'panel-text' }, 'Ninguém criou procedimento no período.')),
      section('dir-rank-title', 'Ranking de produtividade', 'trophy',
        table('dir-rank-table', 'Ranking de produtividade',
          ['#', 'Membro', 'Cargo', 'Pontos', 'Score', 'Principais atividades'].map((t) => h('th', { scope: 'col' }, t)),
          ranking.map((r, i) => {
            const m = memberOf(r.discord_id);
            const top = Object.entries(r.porTipo).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${activityLabel(t)}: ${n}`).join(' · ');
            return h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, profileLink(r.discord_id, nameOf(r.discord_id))),
              h('td', {}, m ? roleBadge(m.role) : '–'), h('td', {}, String(r.pontos)), h('td', {}, scoreBar(r.score)), h('td', { class: 'dir-wrap' }, top));
          }), 'Nenhuma atividade no período.')));
  }

  /* ================================================================ Ocorrências */
  function drawOccurrences() {
    const f = ctx.occ;
    const list = ctx.occurrences.filter((o) => (!f.tipo || o.tipo === f.tipo) && (!f.membro || o.membro_id === f.membro) && within(o.feito_em, f.days));
    const people = [...new Set(ctx.occurrences.map((o) => o.membro_id))].map((id) => [id, nameOf(id)]).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
    const sel = (id, value, pairs, k) => h('select', { class: 'input input--sm', id, onchange: (e) => { f[k] = e.target.value; drawOccurrences(); } }, options(pairs, value));
    panel.replaceChildren(
      h('div', { class: 'dir-toolbar' },
        h('div', { class: 'staff-filters dir-filters' },
          filter('Tipo', sel('dir-occ-tipo', f.tipo, [['', 'Todos'], ...OCCURRENCE_TYPES.map((t) => [t.code, t.label])], 'tipo')),
          filter('Membro', sel('dir-occ-membro', f.membro, [['', 'Todos'], ...people], 'membro')),
          filter('Período', sel('dir-occ-days', f.days, Object.entries(PERIODS), 'days'))),
        h('button', { type: 'button', class: 'btn btn--primary', id: 'dir-new-occ', onclick: () => occurrenceDialog('') }, icon('plus'), 'Registrar ocorrência')),
      h('p', { class: 'panel-text dir-note' }, 'Só a Diretoria vê as ocorrências. O membro não é avisado nem vê no perfil.'),
      list.length
        ? h('ol', { class: 'dir-feed', id: 'dir-feed' }, list.map((o) => {
          const positive = OCCURRENCE_TYPES.find((t) => t.code === o.tipo)?.positive;
          return h('li', { class: `dir-occ dir-occ--${positive ? 'pos' : 'neg'}`, dataset: { tipo: o.tipo } },
            h('span', { class: 'dir-occ-icon' }, icon(OCC_ICONS[o.tipo] ?? 'point')),
            h('div', { class: 'dir-occ-body' },
              h('p', { class: 'dir-occ-head' },
                h('strong', {}, occurrenceLabel(o.tipo)), ' · ',
                // Abre o perfil em outra aba: a lista de ocorrências continua aberta aqui.
                app.feature('perfil')
                  ? h('a', { href: `#/perfil/${o.membro_id}`, target: '_blank', rel: 'noopener' }, o.membro_nome ?? nameOf(o.membro_id))
                  : (o.membro_nome ?? nameOf(o.membro_id))),
              h('p', { class: 'dir-occ-text' }, o.descricao),
              h('p', { class: 'dir-occ-meta' }, `${formatDate(o.feito_em, { time: true })} · registrada por ${o.feito_por_nome ?? nameOf(o.feito_por)}`)));
        }))
        : h('p', { class: 'panel-text' }, 'Nenhuma ocorrência com esses filtros.'));
  }

  /* ================================================================ Cargos */
  async function drawRoles() {
    if (!ctx.grid || ctx.rules === null) {
      panel.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
      const [g, r] = await Promise.all([ctx.grid ? null : app.adapter.listPermissionGrid(), ctx.rules === null ? app.adapter.getPromotionRules() : null]);
      if (!alive || ctx.tab !== 'cargos') return;
      if (g && !g.error) ctx.grid = g.data.grid;
      if (r && failed(r, 'Não foi possível carregar as regras de promoção.')) return;
      if (r) ctx.rules = r.data;
    }
    const days = averageDaysBeforePromotion(ctx.roleHistory, ctx.members);
    const manages = (role) => (role === 'ceo' ? true : Boolean(ctx.grid?.[role]?.['equipe.gerenciar']));
    const histBox = h('div', { id: 'dir-hist-box' });
    const rulesBox = h('div', { id: 'dir-rules-box' });
    panel.replaceChildren(
      section('dir-hier-title', 'Hierarquia', 'hierarchy',
        table('dir-hier-table', 'Hierarquia dos cargos',
          ['Cargo', 'Nível', 'Membros ativos', 'Gerencia a equipe', 'Tempo médio antes de subir'].map((t) => h('th', { scope: 'col' }, t)),
          [...ROLE_LIST].reverse().map((r) => h('tr', {},
            h('td', {}, roleBadge(r.code)), h('td', {}, String(r.level)),
            h('td', {}, String(ctx.members.filter((m) => m.active && m.role === r.code).length)),
            h('td', {}, ctx.grid ? (manages(r.code) ? '✓ Sim' : '✗ Não') : '–'),
            h('td', {}, days[r.code] != null ? `${days[r.code]} ${days[r.code] === 1 ? 'dia' : 'dias'}` : '–')))),
        app.can('permissoes.editar') && h('p', { class: 'panel-text' }, 'Para mudar o que cada cargo pode fazer, use ', h('a', { href: '#/permissoes' }, 'Permissões dos cargos'), '.')),
      section('dir-rules-title', 'Regras de promoção', 'list-check', rulesBox),
      section('dir-hist-title', 'Histórico de mudanças de cargo', 'history', histBox));
    drawRules(rulesBox);
    drawHistory(histBox);
  }

  function drawRules(box) {
    const r = ctx.rules;
    const view = h('div', { class: 'prose dir-rules', id: 'dir-rules' });
    if (r.conteudo.trim()) renderRichMarkdownInto(view, r.conteudo);
    else view.append(h('p', { class: 'panel-text' }, 'Nenhuma regra de promoção escrita ainda.'));
    box.replaceChildren(view,
      r.atualizado_em && h('p', { class: 'dir-occ-meta' }, `Atualizado em ${formatDate(r.atualizado_em, { time: true })}${r.atualizado_por_nome ? ` por ${r.atualizado_por_nome}` : ''}`),
      app.can('diretoria.gerenciar') && h('button', { type: 'button', class: 'btn', id: 'dir-rules-edit', onclick: () => editRules(box) }, icon('pencil'), 'Editar regras'));
  }

  function editRules(box) {
    const text = formField('dir-rules-input', 'Regras de promoção (Markdown)', h('textarea', { class: 'input textarea', rows: 12, maxlength: DIRETORIA_LIMITS.rules }, ctx.rules.conteudo),
      `Até ${DIRETORIA_LIMITS.rules} caracteres. Use ## para títulos e - para listas.`);
    const save = h('button', { type: 'submit', class: 'btn btn--primary', id: 'dir-rules-save' }, 'Salvar');
    const form = h('form', { class: 'dir-rules-form', novalidate: true }, text.el,
      h('div', { class: 'perfil-editor-actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', id: 'dir-rules-cancel', onclick: () => { draft.clear(); draft.stop(); drafts.delete(draft); drawRules(box); } }, 'Cancelar'),
        save));
    box.replaceChildren(form);
    const draft = attachFormDraft(app, 'diretoria:regras', form, { bannerId: 'dir-rules-draft' });
    drafts.add(draft);
    text.input.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      save.disabled = true;
      const r = await app.adapter.savePromotionRules(text.input.value);
      save.disabled = false;
      if (!alive) return;
      if (r.error) { text.error.textContent = errorText(r.error); text.error.hidden = false; return; }
      draft.clear(); draft.stop(); drafts.delete(draft);
      ctx.rules = r.data;
      toast('Regras de promoção salvas.');
      drawRules(box);
    });
  }

  async function drawHistory(box) {
    const f = ctx.hist;
    if (!f.data) {
      box.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
      const r = await app.adapter.listRoleHistory({ memberId: f.member, limit: HISTORY_PAGE, offset: f.page * HISTORY_PAGE });
      if (!alive) return;
      if (failed(r, 'Não foi possível carregar o histórico.')) return;
      f.data = r.data;
    }
    const people = [...new Set(ctx.roleHistory.map((x) => x.membro_id))].map((id) => [id, nameOf(id)]).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
    const pages = Math.max(1, Math.ceil(f.data.total / HISTORY_PAGE));
    const go = (page) => { f.page = page; f.data = null; drawHistory(box); };
    const arrow = (a, b) => (roleLevel(b) > roleLevel(a) ? h('span', { class: 'dir-up' }, '↑ Promoção') : h('span', { class: 'dir-down' }, '↓ Rebaixamento'));
    box.replaceChildren(
      h('div', { class: 'staff-filters dir-filters' }, filter('Membro', h('select', {
        class: 'input input--sm', id: 'dir-hist-member', onchange: (e) => { f.member = e.target.value; go(0); },
      }, options([['', 'Todos'], ...people], f.member)))),
      table('dir-hist-table', 'Histórico de mudanças de cargo',
        ['Membro', 'De', 'Para', 'Tipo', 'Motivo', 'Feito por', 'Quando'].map((t) => h('th', { scope: 'col' }, t)),
        f.data.items.map((x) => h('tr', {},
          h('td', {}, profileLink(x.membro_id, x.membro_nome ?? x.membro_id)),
          h('td', {}, roleBadge(x.cargo_anterior)), h('td', {}, roleBadge(x.cargo_novo)), h('td', {}, arrow(x.cargo_anterior, x.cargo_novo)),
          h('td', { class: 'dir-wrap' }, x.motivo ?? '–'),
          h('td', {}, x.feito_por === 'sistema' ? 'Sistema' : (x.feito_por_nome ?? x.feito_por)),
          h('td', {}, formatDate(x.feito_em, { time: true })))), 'Nenhuma mudança de cargo registrada.'),
      h('div', { class: 'dir-pager', id: 'dir-hist-pager' },
        h('button', { type: 'button', class: 'btn btn--sm', id: 'dir-hist-prev', disabled: f.page === 0 ? true : null, onclick: () => go(f.page - 1) }, '‹ Página anterior'),
        h('span', { class: 'dir-pager-info' }, `Página ${f.page + 1} de ${pages} · ${f.data.total} ${f.data.total === 1 ? 'mudança' : 'mudanças'}`),
        h('button', { type: 'button', class: 'btn btn--sm', id: 'dir-hist-next', disabled: f.page + 1 >= pages ? true : null, onclick: () => go(f.page + 1) }, 'Próxima página ›')));
  }

  /* ================================================================ Alinhamentos (plano 11) */
  // Chama uma pessoa da staff para alinhamento: privado pelo bot, canal (opcional) marcando só ela e reunião na Agenda
  // (opcional, só com agenda.gerenciar). Quem recebe é conferido no servidor (membro ativo, nunca a si mesmo).
  let alignToken = 0;
  const canAgenda = app.feature('agenda') && app.can('agenda.gerenciar');
  const STATUS_TEXT = Object.freeze({ ok: '✓ Enviado', falha: '✗ Falhou' });

  async function drawAlignments() {
    const token = ++alignToken;
    const f = ctx.align;
    panel.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));
    const [people, hist] = await Promise.all([
      access.full ? Promise.resolve({ data: ctx.members.filter((m) => m.active), error: null }) : app.adapter.listStaffNames(),
      app.adapter.listAlignments({ limit: ALIGN_PAGE, offset: f.page * ALIGN_PAGE }),
    ]);
    if (!alive || token !== alignToken || ctx.tab !== 'alinhamentos') return;
    if (failed(people, 'Não foi possível carregar a equipe.') || failed(hist, 'Não foi possível carregar os alinhamentos.')) { panel.replaceChildren(); return; }
    const choices = people.data.filter((m) => m.discord_id !== me.discord_id)
      .sort((a, b) => a.display_name.localeCompare(b.display_name, 'pt-BR'))
      .map((m) => [m.discord_id, m.role ? `${m.display_name} (${roleLabel(m.role)})` : m.display_name]);

    const member = formField('dir-al-member', 'Membro', h('select', { class: 'input' }, options([['', 'Escolha um membro'], ...choices], '')));
    const manual = formField('dir-al-id', 'ou o Discord ID', h('input', { class: 'input input--mono', type: 'text', inputmode: 'numeric', maxlength: 20, placeholder: 'Ex.: 701607812903600210' }),
      'Use quando a pessoa não aparece na lista. Só membros ativos da staff recebem.');
    const channel = formField('dir-al-canal', 'ID do canal (opcional)', h('input', { class: 'input input--mono', type: 'text', inputmode: 'numeric', maxlength: 20 }),
      'Em branco: só no privado. Com o ID, o bot também posta no canal marcando só a pessoa.');
    const deadlines = h('div', { class: 'dir-al-deadlines', role: 'radiogroup', 'aria-labelledby': 'dir-al-prazo-label' },
      ALIGNMENT_DEADLINES.map((d) => h('label', { class: 'dir-al-deadline' },
        h('input', { type: 'radio', name: 'dir-al-prazo', id: `dir-al-prazo-${d.code}`, value: d.code, checked: d.code === 'qualquer_momento' }), ' ', d.label)));
    const deadlineError = h('p', { class: 'field-error', id: 'dir-al-prazo-err', hidden: true });
    const message = formField('dir-al-msg', 'Mensagem', h('textarea', { class: 'input textarea', rows: 4, maxlength: ALIGNMENT_MESSAGE_MAX, placeholder: 'Motivo do alinhamento' }));
    const counter = h('p', { class: 'field-hint', id: 'dir-al-count', 'aria-live': 'polite' });
    const paint = () => { counter.textContent = `${message.input.value.length} de ${ALIGNMENT_MESSAGE_MAX} caracteres`; };
    message.input.addEventListener('input', paint);
    paint();
    const call = formField('dir-al-call', 'Link da call (opcional)', h('input', { class: 'input', type: 'url', maxlength: 300, placeholder: 'https://discord.gg/...' }),
      'Só links discord.gg ou discord.com/channels.');
    const when = canAgenda && formField('dir-al-when', 'Reunião na Agenda (opcional)', h('input', { class: 'input', type: 'datetime-local' }),
      'Com dia e horário, a reunião entra na Agenda com a pessoa e você.');
    const general = h('p', { class: 'field-error', id: 'dir-al-error', role: 'alert', hidden: true });
    const result = h('div', { id: 'dir-al-result', 'aria-live': 'polite' });
    const send = h('button', { type: 'submit', class: 'btn btn--primary', id: 'dir-al-send', 'data-requires-online': '' }, icon('send'), 'Chamar para alinhamento');
    const form = h('form', { class: 'dir-form dir-al-form', id: 'dir-al-form', novalidate: true },
      h('div', { class: 'dir-form-row' }, member.el, manual.el),
      h('div', { class: 'field' }, h('span', { class: 'field-label', id: 'dir-al-prazo-label' }, 'Prazo para o alinhamento'), deadlines, deadlineError),
      message.el, counter,
      h('div', { class: 'dir-form-row' }, channel.el, call.el),
      when && when.el, general, h('div', { class: 'panel-actions' }, send), result);
    // Plano 12: vindo da ficha de decisão ("acompanhar"), a pessoa e a mensagem já chegam preenchidas.
    if (f.preset) {
      if (choices.some(([v]) => v === f.preset.membro_id)) member.input.value = f.preset.membro_id;
      else manual.input.value = f.preset.membro_id;
      message.input.value = f.preset.mensagem.slice(0, ALIGNMENT_MESSAGE_MAX);
      paint();
      f.preset = null;
    }
    const draft = attachFormDraft(app, 'diretoria:alinhamento', form, { bannerId: 'dir-al-draft', hasContent: (v) => Boolean(String(v['dir-al-msg'] ?? '').trim()) });
    drafts.add(draft);

    const fields = { membro_id: member, mensagem: message, canal_id: channel, link_call: call, prazo: { error: deadlineError }, ...(when ? { reuniao_em: when } : {}) };
    const request = () => ({
      membro_id: member.input.value || manual.input.value.trim(),
      mensagem: message.input.value, prazo: form.querySelector('input[name="dir-al-prazo"]:checked')?.value ?? '',
      canal_id: channel.input.value.trim(), link_call: call.input.value.trim(),
      reuniao_em: when && when.input.value ? new Date(when.input.value).toISOString() : '',
    });
    const nameFor = (id) => choices.find(([v]) => v === id)?.[1] ?? id;

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (send.disabled) return;
      const req = request();
      showErrors(fields, general, {});
      result.replaceChildren();
      const d = alignmentDeadline(req.prazo);
      const yes = await openDialog({
        title: 'Chamar para alinhamento?',
        body: h('div', { class: 'areas-confirm', id: 'dir-al-confirm' },
          h('p', {}, `O bot manda no privado de ${nameFor(req.membro_id) || 'quem você escolheu'}${req.canal_id ? ` e posta no canal ${req.canal_id}` : ''}. Prazo: ${d ? d.text : '(escolha o prazo)'}.`),
          req.reuniao_em && h('p', {}, `Reunião na Agenda: ${formatDate(req.reuniao_em, { time: true })}.`),
          h('pre', { class: 'areas-preview' }, req.mensagem.trim())),
        actions: [{ label: 'Voltar', value: false, variant: 'ghost', autofocus: true }, { label: 'Chamar', value: true, variant: 'primary' }],
      });
      if (!yes || !alive || token !== alignToken) return;
      send.disabled = true;
      send.textContent = 'Enviando…';
      const r = await app.adapter.callAlignment(req);
      if (!alive || token !== alignToken) return;
      send.disabled = false;
      send.replaceChildren(icon('send'), 'Chamar para alinhamento');
      if (r.error) {
        const errs = r.error.details?.errors;
        showErrors(fields, general, errs ?? { _: errorText(r.error) });
        return;
      }
      draft.clear();
      const dm = r.data.dm?.status === 'ok' ? '✓ Privado enviado.' : `✗ O privado não chegou (${r.data.dm?.erro ?? 'motivo desconhecido'}).`;
      const canal = !r.data.canal ? '' : r.data.canal.status === 'ok' ? ' ✓ Mensagem no canal enviada.' : ` ✗ ${r.data.canal.erro ?? 'O canal recusou.'}`;
      const agenda = r.data.reuniao_id ? ' ✓ Reunião criada na Agenda.' : '';
      toast(`Alinhamento chamado para ${nameFor(req.membro_id)}.`);
      f.page = 0;
      await drawAlignments();
      document.getElementById('dir-al-result')?.replaceChildren(h('p', { class: `banner ${r.data.dm?.status === 'ok' ? 'banner--ok' : 'banner--info'}` }, `${dm}${canal}${agenda}`));
    });

    const pages = Math.max(1, Math.ceil(hist.data.total / ALIGN_PAGE));
    const go = (page) => { f.page = page; drawAlignments(); };
    const status = (st, erro) => (st ? h('span', { class: st === 'ok' ? 'dir-up' : 'dir-down', title: erro ?? '' }, STATUS_TEXT[st]) : h('span', { class: 'dir-muted' }, '–'));
    panel.replaceChildren(
      section('dir-al-title', 'Chamar para alinhamento', 'message-circle',
        h('p', { class: 'panel-text' }, 'O bot manda a mensagem no privado da pessoa, com o prazo. Uma DM fechada não recebe; o motivo fica no registro.'),
        form),
      section('dir-al-hist-title', 'Alinhamentos chamados', 'history',
        table('dir-al-table', 'Alinhamentos chamados',
          ['Membro', 'Prazo', 'Mensagem', 'Privado', 'Canal', 'Agenda', 'Chamado por', 'Quando'].map((t) => h('th', { scope: 'col' }, t)),
          hist.data.items.map((x) => h('tr', {},
            h('td', {}, profileLink(x.membro_id, x.membro_nome ?? x.membro_id)),
            h('td', {}, alignmentDeadline(x.prazo)?.label ?? x.prazo, x.prazo_em ? h('span', { class: 'dir-comment' }, `até ${ddmm(x.prazo_em)}`) : null),
            h('td', { class: 'dir-wrap' }, x.mensagem),
            h('td', {}, status(x.dm_status, x.dm_erro)), h('td', {}, status(x.canal_status, x.canal_erro)),
            h('td', {}, x.reuniao_id ? h('a', { href: '#/agenda' }, 'Na Agenda') : '–'),
            h('td', {}, x.chamado_por_nome ?? x.chamado_por),
            h('td', {}, formatDate(x.criado_em, { time: true })))), 'Nenhum alinhamento chamado ainda.'),
        pages > 1 && h('div', { class: 'dir-pager', id: 'dir-al-pager' },
          h('button', { type: 'button', class: 'btn btn--sm', disabled: f.page === 0 ? true : null, onclick: () => go(f.page - 1) }, '‹ Página anterior'),
          h('span', { class: 'dir-pager-info' }, `Página ${f.page + 1} de ${pages}`),
          h('button', { type: 'button', class: 'btn btn--sm', disabled: f.page + 1 >= pages ? true : null, onclick: () => go(f.page + 1) }, 'Próxima página ›'))));
    app.applyOnline?.();
  }

  /* ================================================================ janelas */

  /**
   * Janela com formulário (usa o openDialog do site). Se a validação ou o banco recusar, a janela
   * reabre com os mesmos campos e a mensagem no lugar certo. `submit` devolve null (ok) ou o erro.
   */
  async function formDialog({ title, body, confirmLabel, validate, submit, draft }) {
    for (;;) {
      const choice = await openDialog({ title, body, actions: [
        { label: 'Cancelar', value: false, variant: 'ghost' }, { label: confirmLabel, value: true, variant: 'primary', autofocus: true },
      ] });
      if (!alive) return false;
      if (!choice) { draft?.clear(); break; }
      const local = validate();
      if (local) continue;
      const error = await submit();
      if (!alive) return false;
      if (!error) { draft?.clear(); draft?.stop(); drafts.delete(draft); return true; }
    }
    draft?.stop();
    drafts.delete(draft);
    return false;
  }

  /** Mostra os erros por campo; devolve true se havia algum. */
  function showErrors(fields, general, errors) {
    for (const f of Object.values(fields)) f.error.hidden = true;
    general.hidden = true;
    let any = false;
    for (const [k, msg] of Object.entries(errors ?? {})) {
      any = true;
      if (fields[k]) { fields[k].error.textContent = msg; fields[k].error.hidden = false; } else { general.textContent = msg; general.hidden = false; }
    }
    return any;
  }

  const memberSelect = (id, preset) => h('select', { class: 'input' },
    options([['', 'Escolha o membro'], ...targets().map((m) => [m.discord_id, `${m.display_name} (${roleLabel(m.role)})`])], preset));

  async function evaluationDialog(preset) {
    const who = formField('dir-ev-member', 'Membro avaliado', memberSelect('dir-ev-member', preset));
    const start = formField('dir-ev-start', 'Início do período', h('input', { class: 'input', type: 'date', value: daysAgoIso(30) }));
    const end = formField('dir-ev-end', 'Fim do período', h('input', { class: 'input', type: 'date', value: todayIso() }));
    const summary = h('p', { class: 'dir-ev-summary', id: 'dir-ev-summary', 'aria-live': 'polite' });
    const scoreFields = {};
    const sliders = SCORE_FIELDS.map((s) => {
      const out = h('output', { class: 'dir-slider-value', id: `dir-ev-${s.key}-out` }, '7,0');
      const input = h('input', { class: 'dir-slider', type: 'range', min: 0, max: 10, step: 0.5, value: 7, id: `dir-ev-${s.key}`, 'aria-describedby': `dir-ev-${s.key}-out` });
      const error = h('p', { class: 'field-error', hidden: true });
      scoreFields[s.key] = { input, error };
      input.addEventListener('input', () => { out.textContent = fmt(Number(input.value)); updateSummary(); });
      return h('div', { class: 'dir-slider-row' }, h('label', { class: 'field-label', for: input.id }, s.label), input, out, error);
    });
    const scores = () => Object.fromEntries(SCORE_FIELDS.map((s) => [s.key, Number(scoreFields[s.key].input.value)]));
    function updateSummary() {
      const avg = scoreAverage(scores());
      const band = scoreBand(avg);
      summary.dataset.tone = band.tone;
      summary.textContent = `Média atual: ${fmt(avg)} · ${band.label}`;
    }
    updateSummary();
    const comment = formField('dir-ev-comment', 'Comentário', h('textarea', { class: 'input textarea', rows: 3, maxlength: DIRETORIA_LIMITS.comment }));
    const counter = h('p', { class: 'field-hint', id: 'dir-ev-count', 'aria-live': 'polite' }, `0 de ${DIRETORIA_LIMITS.comment} caracteres`);
    comment.input.addEventListener('input', () => { counter.textContent = `${comment.input.value.length} de ${DIRETORIA_LIMITS.comment} caracteres`; });
    const visible = h('input', { type: 'checkbox', id: 'dir-ev-visible', checked: true });
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    // Plano 11 (SQL 22): área opcional e "mostrar o comentário". Sem o SQL 22 no banco, a janela fica como antes.
    const withArea = app.feature('avaliacoes_area');
    let area = null;
    let showComment = null;
    if (withArea) {
      const list = await app.adapter.getEvaluationsByArea();
      if (!alive) return;
      const areas = list.error ? [] : list.data.filter((a) => a.area_id && a.status === 'ativa');
      area = formField('dir-ev-area', 'Área (opcional)', h('select', { class: 'input' },
        options([['', 'Sem área específica'], ...areas.map((a) => [a.area_id, a.area_nome])], '')),
      'Sem área, a avaliação conta nas áreas em que o membro está hoje.');
      showComment = h('input', { type: 'checkbox', id: 'dir-ev-show-comment' });
      const sync = () => { showComment.disabled = !visible.checked; if (!visible.checked) showComment.checked = false; };
      visible.addEventListener('change', sync);
    }
    const visibleText = withArea
      ? ' Visível para o avaliado (ele vê as notas no próprio perfil, sem saber quem avaliou)'
      : ' Visível para o avaliado (ele vê só a média, no próprio perfil)';
    const body = h('form', { class: 'dir-form', id: 'dir-ev-form', novalidate: true, onsubmit: (e) => e.preventDefault() },
      who.el, area?.el, h('div', { class: 'dir-form-row' }, start.el, end.el), h('fieldset', { class: 'dir-sliders' }, h('legend', { class: 'field-label' }, 'Notas de 0 a 10'), sliders),
      summary, comment.el, counter,
      h('label', { class: 'perfil-check' }, visible, visibleText),
      showComment && h('label', { class: 'perfil-check' }, showComment, ' Mostrar o comentário ao avaliado (sem o nome de quem avaliou)'), general);
    const draft = attachFormDraft(app, `diretoria:avaliacao:${preset || 'nova'}`, body, { bannerId: 'dir-ev-draft' });
    drafts.add(draft);
    const fields = { avaliado_id: who, periodo_inicio: start, periodo_fim: end, comentario: comment, ...scoreFields, ...(area ? { area_id: area } : {}) };
    const input = () => ({
      avaliado_id: who.input.value, periodo_inicio: start.input.value, periodo_fim: end.input.value, ...scores(), comentario: comment.input.value, visivel_avaliado: visible.checked,
      ...(withArea ? { area_id: area.input.value, comentario_visivel: showComment.checked } : {}),
    });
    let saved = null;
    const done = await formDialog({
      title: 'Nova avaliação', body, confirmLabel: 'Salvar avaliação', draft,
      validate: () => showErrors(fields, general, validateDirectorEvaluation(me, memberOf(who.input.value), input())),
      submit: async () => {
        const r = await app.adapter.saveDirectorEvaluation(input());
        if (r.error) { showErrors(fields, general, r.error.details?.errors ?? { _: errorText(r.error) }); return r.error; }
        saved = r.data;
        return null;
      },
    });
    if (done && saved) {
      toast(`Avaliação de ${nameOf(saved.avaliado_id)} salva: nota ${fmt(saved.nota_geral)}.`);
      await refresh({ members: true, evaluations: true });
    }
  }

  async function occurrenceDialog(preset, suggested = {}) {
    const who = formField('dir-oc-member', 'Membro', memberSelect('dir-oc-member', preset));
    const type = formField('dir-oc-tipo', 'Tipo', h('select', { class: 'input' }, options([['', 'Escolha o tipo'], ...OCCURRENCE_TYPES.map((t) => [t.code, t.label])], suggested.tipo ?? '')));
    const text = formField('dir-oc-text', 'Descrição', h('textarea', { class: 'input textarea', rows: 4, maxlength: DIRETORIA_LIMITS.occurrence }, suggested.descricao ?? ''),
      'Só a Diretoria vê. O membro não é avisado.');
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const body = h('form', { class: 'dir-form', id: 'dir-oc-form', novalidate: true, onsubmit: (e) => e.preventDefault() }, who.el, type.el, text.el, general);
    const draft = attachFormDraft(app, `diretoria:ocorrencia:${preset || 'nova'}`, body, { bannerId: 'dir-oc-draft' });
    drafts.add(draft);
    const fields = { membro_id: who, tipo: type, descricao: text };
    const input = () => ({ membro_id: who.input.value, tipo: type.input.value, descricao: text.input.value });
    let saved = null;
    const done = await formDialog({
      title: 'Registrar ocorrência', body, confirmLabel: 'Registrar', draft,
      validate: () => showErrors(fields, general, validateOccurrence(me, memberOf(who.input.value), input())),
      submit: async () => {
        const r = await app.adapter.saveOccurrence(input());
        if (r.error) { showErrors(fields, general, r.error.details?.errors ?? { _: errorText(r.error) }); return r.error; }
        saved = r.data;
        return null;
      },
    });
    if (done && saved) {
      toast(`${occurrenceLabel(saved.tipo)} registrada para ${nameOf(saved.membro_id)}.`);
      await refresh({ members: true, occurrences: true });
    }
    return Boolean(done && saved);
  }

  async function roleDialog(m, suggested = {}) {
    const roles = assignableRoles(me.role).filter((r) => r !== m.role);
    const role = formField('dir-role-new', 'Novo cargo', h('select', { class: 'input' },
      options([...roles].reverse().map((r) => [r, `${roleLabel(r)}${roleLevel(r) > roleLevel(m.role) ? ' (promoção)' : ' (rebaixamento)'}`]),
        roles.includes(suggested.role) ? suggested.role : roles.at(-1))));
    const reason = formField('dir-role-reason', 'Motivo', h('textarea', { class: 'input textarea', rows: 3, maxlength: DIRETORIA_LIMITS.reason }, (suggested.motivo ?? '').slice(0, DIRETORIA_LIMITS.reason)),
      'Opcional. Fica no histórico de cargos.');
    const general = h('p', { class: 'field-error', role: 'alert', hidden: true });
    const body = h('form', { class: 'dir-form', id: 'dir-role-form', novalidate: true, onsubmit: (e) => e.preventDefault() },
      h('p', {}, `${m.display_name} hoje é `, roleBadge(m.role), '.'), role.el, reason.el, general);
    const fields = { role, motivo: reason };
    let saved = null;
    const done = await formDialog({
      title: 'Alterar cargo', body, confirmLabel: 'Confirmar',
      validate: () => showErrors(fields, general, reasonError(reason.input.value) ? { motivo: reasonError(reason.input.value) } : {}),
      submit: async () => {
        const r = await app.adapter.changeMemberRole(m.discord_id, role.input.value, reason.input.value);
        if (r.error) { showErrors(fields, general, r.error.details?.errors ?? { _: errorText(r.error) }); return r.error; }
        saved = r.data;
        return null;
      },
    });
    if (!done || !saved) return false;
    // Atualiza a linha na hora (sem recarregar a página) e depois relê tudo do banco.
    Object.assign(m, { role: saved.role, cargo_desde: new Date().toISOString() });
    ctx.membersAt = 0;
    if (ctx.tab === 'equipe') drawPanel();
    toast(`${m.display_name} agora é ${roleLabel(saved.role)}.`);
    await refresh({ members: true, history: true });
    return true;
  }

  load();
  return () => {
    alive = false;
    stopTeamEvaluations();
    for (const d of drafts) d.stop();
  };
}

/** Tela de acesso restrito, com volta para o Início (nunca deixa erro solto). */
function restricted(app, title, text) {
  app.els.main.replaceChildren(h('div', { class: 'main-inner dir-page' },
    h('section', { class: 'dir-restricted', id: 'dir-restricted' },
      icon('lock'),
      h('h1', { class: 'page-title', tabindex: '-1' }, title),
      h('p', { class: 'page-sub' }, text),
      h('a', { class: 'btn btn--primary', href: '#/painel' }, icon('arrow-left'), 'Voltar ao Início'))));
}
