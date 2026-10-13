// Etapa 3 · avaliações de membros pelo Head Staff (documento 01, seção 6; decisões 7 a 9 e 10.3).
//   #/avaliacoes-equipe          período atual, "Minhas avaliações" (quem avalia), caixa da Direção
//                                (avaliacoes.ler) e, para avaliacoes.gerenciar, períodos e critérios
//   #/avaliacoes-equipe/nova     formulário novo (só com período aberto)
//   #/avaliacoes-equipe/<id>     edição (rascunho, ou até 24 h depois de enviar) ou leitura
// O avaliado nunca vê; quem garante é o banco (supabase/08_avaliacoes.sql).
// Plano 12 (SQL 23, feature "avaliacoes_decisoes"): justificativa nas recomendações graves, comentário e evidências por
// critério, produtividade do avaliado à vista, rascunho automático, cobertura do período com lembretes pelo bot,
// exportação do período e as decisões da Direção (registradas no Painel da Diretoria, aba Decisões).
import { downloadText, h, icon, toast } from '../dom.js';
import { confirmDialog } from '../modal.js';
import { formatDate, roleBadge } from '../components.js';
import { roleLabel, roleLevel } from '../../core/permissions.js';
import {
  EDIT_WINDOW_MS, EVALUATION_LIMITS, PERIOD_DEFAULT_DAYS, RECOMMENDATIONS, isPeriodOpen, recommendationLabel,
  stars, suggestedOverall, withinEditWindow,
} from '../../core/workflow.js';
import { renderMessage } from './message.js';
import { createDraft } from '../draft.js';
import {
  CRITERION_LIMITS, JUSTIFICATION_MAX, JUSTIFICATION_MIN, decisionLabel, latestDecisions, needsJustification, parseEvidence,
  periodCoverage, periodCsv, periodExportRows, periodMarkdown,
} from '../../core/avaliacoes.js';

const STATUS_TEXT = { rascunho: 'Rascunho', enviada: 'Enviada', arquivada: 'Arquivada' };
const pad = (n) => String(n).padStart(2, '0');
/** ISO → valor de <input type="datetime-local"> no horário do navegador. */
export function toLocalInput(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const fromLocalInput = (v) => (v ? new Date(v).toISOString() : '');
const brToday = () => new Date(Date.now() - 3 * 3600_000).toISOString().slice(0, 10);
/** Plano 12 ligado neste banco (o SQL 23 já rodou)? */
const plus = (app) => app.feature('avaliacoes_decisoes');
const errorOf = (error) => error?.details?.errors?._ ?? Object.values(error?.details?.errors ?? {})[0] ?? error?.message ?? 'Algo deu errado.';

const roles = (app) => ({
  create: app.can('avaliacoes.criar'), read: app.can('avaliacoes.ler'), manage: app.can('avaliacoes.gerenciar'),
});

function denied(app) {
  const r = roles(app);
  if (!app.feature('avaliacoes') || !(r.create || r.read || r.manage)) {
    renderMessage(app, { title: 'Acesso restrito', text: 'Seu cargo não participa das avaliações da equipe.' });
    return true;
  }
  return false;
}

function periodState(p, now = Date.now()) {
  if (isPeriodOpen(p, now)) return { label: 'Aberto', cls: 'badge--suporte' };
  return new Date(p.starts_at).getTime() > now ? { label: 'Agendado', cls: 'badge--status' } : { label: 'Encerrado', cls: 'badge--status' };
}

/* ============================ lista ============================ */
export function renderEvaluations(app) {
  if (denied(app)) return null;
  const body = h('div', {});
  app.els.main.replaceChildren(h('div', { class: 'main-inner evaluations-page' },
    h('a', { class: 'back', href: '#/' }, icon('arrow-left'), 'Voltar para a lista'),
    h('header', { class: 'page-head' },
      h('h1', { class: 'page-title', tabindex: '-1' }, 'Avaliações da equipe'),
      h('p', { class: 'page-sub' }, 'O Head Staff avalia membros de cargo abaixo durante o período aberto pela Direção. Só a Direção (Resp. Equipe, Administradores e CEO) lê as avaliações enviadas; o membro avaliado nunca vê.')),
    body));
  return mountTeamEvaluations(app, body);
}

/**
 * Conteúdo da lista (período, Minhas avaliações, Caixa da Direção, períodos e critérios) dentro de `body`.
 * Usado por esta página e pela aba Avaliações do Painel da Diretoria (plano 11). Devolve a limpeza.
 */
export function mountTeamEvaluations(app, body) {
  const r = roles(app);
  const me = app.state.staff.discord_id;
  let alive = true;
  body.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando…'));

  async function load() {
    const [periods, criteria, evaluations, staff] = await Promise.all([
      app.adapter.listEvaluationPeriods(),
      app.adapter.listEvaluationCriteria(),
      app.adapter.listEvaluations(),
      r.read && app.can('equipe.ver') ? app.adapter.listStaff() : Promise.resolve({ data: [], error: null }),
    ]);
    if (!alive) return;
    const err = [periods, criteria, evaluations].find((x) => x.error);
    if (err) { app.reportError(err.error, 'Não foi possível carregar as avaliações.'); body.replaceChildren(); return; }
    // Plano 12: cobertura do período aberto, lembretes enviados e decisões da Direção (cada um só com a permissão dele).
    const current = periods.data.find((p) => isPeriodOpen(p));
    const extra = plus(app) ? await Promise.all([
      current && (r.read || r.manage) ? app.adapter.getEvaluationCoverage(current.id) : null,
      current && (r.read || r.manage) ? app.adapter.listEvaluationReminders(current.id) : null,
      app.can('diretoria.ver') ? app.adapter.listEvaluationDecisions() : null,
    ]) : [null, null, null];
    if (!alive) return;
    const [coverage, reminders, decisions] = extra.map((x) => (x && !x.error ? x.data : null));
    render({ periods: periods.data, criteria: criteria.data, evaluations: evaluations.data, staff: staff.data ?? [], coverage, reminders, decisions });
  }

  function render({ periods, criteria, evaluations, staff, coverage = null, reminders = null, decisions = null }) {
    const now = Date.now();
    const open = periods.filter((p) => isPeriodOpen(p, now));
    const periodName = (id) => periods.find((p) => p.id === id)?.title ?? '';
    const mine = evaluations.filter((e) => e.evaluator_id === me);
    const inbox = evaluations.filter((e) => e.evaluator_id !== me || r.read).filter((e) => e.status !== 'rascunho');

    const periodBanner = open.length
      ? h('div', { class: 'banner banner--ok', id: 'eval-period' }, icon('calendar-check'),
        h('p', {}, open.map((p) => `Período aberto: ${p.title}, até ${formatDate(p.ends_at, { time: true })}.`).join(' ')))
      : h('div', { class: 'banner banner--info', id: 'eval-period' }, icon('calendar-off'),
        h('p', {}, 'Nenhum período de avaliação aberto. A Direção abre um período quando for hora de avaliar.'));

    const sections = [periodBanner];
    if (open[0] && coverage) sections.push(coverageSection(open[0], evaluations, staff, coverage, reminders ?? []));

    if (r.create) {
      sections.push(h('section', { class: 'panel', 'aria-labelledby': 'eval-mine-title' },
        h('h2', { class: 'block-title', id: 'eval-mine-title' }, icon('pencil'), 'Minhas avaliações'),
        h('div', { class: 'panel-actions' },
          open.length
            ? h('a', { class: 'btn btn--primary', href: '#/avaliacoes-equipe/nova', id: 'eval-new' }, icon('plus'), 'Nova avaliação')
            : h('button', { type: 'button', class: 'btn btn--primary', id: 'eval-new', disabled: true }, icon('plus'), 'Nova avaliação')),
        h('ul', { class: 'staff-list', id: 'eval-mine' }, mine.length ? mine.map((e) => {
          const editable = e.status === 'rascunho' || withinEditWindow(e, now);
          return h('li', { class: 'staff-row' },
            h('div', { class: 'staff-who' },
              h('p', { class: 'staff-name' }, h('a', { class: 'staff-link', href: `#/avaliacoes-equipe/${e.id}` }, e.evaluated_name ?? e.evaluated_id)),
              h('p', { class: 'staff-meta' }, periodName(e.period_id),
                e.submitted_at && ` · enviada em ${formatDate(e.submitted_at, { time: true })}`,
                e.status === 'enviada' && editable && ` · pode corrigir até ${formatDate(new Date(new Date(e.submitted_at).getTime() + EDIT_WINDOW_MS).toISOString(), { time: true })}`)),
            h('div', { class: 'staff-tags' },
              h('span', { class: `badge ${e.status === 'rascunho' ? 'badge--revisar' : 'badge--status'}` }, STATUS_TEXT[e.status]),
              e.overall && h('span', { class: 'stars', 'aria-label': `Nota geral ${e.overall} de 5` }, stars(e.overall))));
        }) : h('li', { class: 'staff-empty' }, 'Você ainda não fez avaliações.'))));
    }

    if (r.read) sections.push(inboxSection(inbox, periods, open, staff, decisions));
    if (r.manage) sections.push(periodsSection(periods), criteriaSection(criteria));
    body.replaceChildren(...sections);
    app.applyOnline();
  }

  /* ---------- caixa da Direção ---------- */
  function inboxSection(list, periods, open, staff, decisions) {
    const last = decisions ? latestDecisions(decisions) : null;
    const decisionTag = (e) => {
      if (!last || !e.recommendation) return null;
      const d = last.get(e.id);
      return h('span', { class: `badge ${d && d.decision !== 'adiada' ? 'badge--status' : 'badge--revisar'}`, dataset: { decision: d?.decision ?? 'pendente' } },
        d ? `Direção: ${decisionLabel(d.decision)}` : 'Aguardando decisão');
    };
    const f = { member: '', evaluator: '', period: '', recommendation: '', unread: false };
    const ul = h('ul', { class: 'staff-list', id: 'eval-inbox' });
    const counter = h('p', { class: 'panel-text', id: 'eval-unread', 'aria-live': 'polite' });
    const names = (key, nameKey) => [...new Map(list.map((e) => [e[key], e[nameKey] ?? e[key]])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
    const select = (key, label, options) => h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label),
      h('select', { class: 'input input--sm', id: `eval-f-${key}`, onchange: (e) => { f[key] = e.target.value; draw(); } },
        h('option', { value: '' }, 'Todos'), options.map(([v, t]) => h('option', { value: v }, t))));

    function draw() {
      const unread = list.filter((e) => e.status === 'enviada' && !e.read_at).length;
      counter.textContent = unread ? `● ${unread} ${unread === 1 ? 'avaliação nova' : 'avaliações novas'}` : 'Nenhuma avaliação nova.';
      const shown = list.filter((e) => (!f.member || e.evaluated_id === f.member) && (!f.evaluator || e.evaluator_id === f.evaluator)
        && (!f.period || e.period_id === f.period) && (!f.recommendation || e.recommendation === f.recommendation)
        && (!f.unread || (e.status === 'enviada' && !e.read_at)));
      ul.replaceChildren(...(shown.length ? shown.map((e) => h('li', { class: `staff-row${!e.read_at && e.status === 'enviada' ? ' staff-row--unread' : ''}` },
        h('div', { class: 'staff-who' },
          h('p', { class: 'staff-name' },
            !e.read_at && e.status === 'enviada' && h('span', { class: 'unread-dot', 'aria-label': 'Nova' }, '● '),
            h('a', { class: 'staff-link', href: `#/avaliacoes-equipe/${e.id}` }, e.evaluated_name ?? e.evaluated_id)),
          h('p', { class: 'staff-meta' }, `por ${e.evaluator_name ?? e.evaluator_id} · ${formatDate(e.submitted_at, { time: true })}`,
            e.status === 'arquivada' && ' · arquivada')),
        h('div', { class: 'staff-tags' },
          h('span', { class: 'stars', 'aria-label': `Nota geral ${e.overall} de 5` }, stars(e.overall)),
          h('span', { class: 'badge badge--status' }, recommendationLabel(e.recommendation)), decisionTag(e))))
        : [h('li', { class: 'staff-empty' }, 'Nenhuma avaliação com esses filtros.')]));
    }
    draw();

    // Quem ainda não recebeu avaliação no período aberto (cargos até Head Staff).
    const current = open[0];
    const pending = current ? staff.filter((m) => m.active && roleLevel(m.role) <= 5
      && !list.some((e) => e.period_id === current.id && e.evaluated_id === m.discord_id && e.status !== 'rascunho')) : [];

    return h('section', { class: 'panel', 'aria-labelledby': 'eval-inbox-title' },
      h('h2', { class: 'block-title', id: 'eval-inbox-title' }, icon('inbox'), 'Caixa da Direção'),
      counter,
      h('div', { class: 'staff-filters' },
        select('member', 'Membro', names('evaluated_id', 'evaluated_name')),
        select('evaluator', 'Avaliador', names('evaluator_id', 'evaluator_name')),
        select('period', 'Período', periods.map((p) => [p.id, p.title])),
        select('recommendation', 'Recomendação', RECOMMENDATIONS.map((x) => [x.code, x.label])),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'eval-f-unread', onchange: (e) => { f.unread = e.target.checked; draw(); } }), 'Só as novas')),
      ul,
      plus(app) && periods.length > 0 && exportBox(list, periods, staff, decisions),
      current && staff.length > 0 && h('details', { class: 'eval-pending', id: 'eval-pending' },
        h('summary', {}, `Sem avaliação em "${current.title}" (${pending.length})`),
        pending.length
          ? h('ul', { class: 'plain-list' }, pending.map((m) => h('li', {}, h('a', { href: `#/equipe/${m.discord_id}` }, m.display_name), ' ', roleBadge(m.role))))
          : h('p', { class: 'panel-text' }, 'Todos já foram avaliados neste período.')));
  }

  /* ---------- cobertura do período aberto (plano 12) ---------- */
  function coverageSection(period, evaluations, staff, evaluators, reminders) {
    const c = periodCoverage({ period, evaluations, staff, evaluators });
    const remind = async (kind) => {
      const ok = await confirmDialog({
        title: kind === 'abertura' ? 'Avisar quem avalia?' : 'Lembrar quem ainda não avaliou?',
        message: kind === 'abertura'
          ? `O bot manda no privado de ${evaluators.length} ${evaluators.length === 1 ? 'pessoa' : 'pessoas'} que avaliam, com o prazo do período.`
          : `O bot manda no privado de quem ainda não enviou nenhuma avaliação neste período (${c.idleEvaluators.length}).`,
        confirmLabel: 'Enviar no privado',
      });
      if (!ok) return;
      const res = await app.adapter.sendEvaluationReminder({ period_id: period.id, kind, siteUrl: location.href.split('#')[0] });
      if (res.error) { toast(errorOf(res.error), 5000); return; }
      const failed = res.data.dm?.failed ?? [];
      toast(`✓ Lembrete enviado para ${res.data.dm?.sent ?? 0}.${failed.length ? ` ✗ Não chegou para: ${failed.join(', ')} (DM fechada).` : ''}`, 5000);
      load();
    };
    const lastReminder = reminders[0];
    return h('section', { class: 'panel eval-coverage', id: 'eval-coverage', 'aria-labelledby': 'eval-coverage-title' },
      h('h2', { class: 'block-title', id: 'eval-coverage-title' }, icon('chart-pie'), `Cobertura de "${period.title}"`),
      h('div', { class: 'eval-kpis' },
        h('p', { class: 'eval-kpi', dataset: { kpi: 'prazo' } }, h('strong', {}, c.timeLeft), h('span', {}, `fecha em ${formatDate(period.ends_at, { time: true })}`)),
        h('p', { class: 'eval-kpi', dataset: { kpi: 'avaliados' } }, h('strong', {}, `${c.evaluated} de ${c.total}`), h('span', {}, 'membros já avaliados')),
        h('p', { class: 'eval-kpi', dataset: { kpi: 'parados' } }, h('strong', {}, String(c.idleEvaluators.length)), h('span', {}, 'avaliadores sem nenhuma enviada'))),
      evaluators.length
        ? h('ul', { class: 'plain-list eval-evaluators', id: 'eval-evaluators' }, evaluators.map((x) => h('li', {},
          h('span', { class: x.enviadas ? 'dir-up' : 'dir-down' }, x.enviadas ? '✓' : '○'), ' ', x.display_name, ' ', roleBadge(x.role),
          h('span', { class: 'staff-meta' }, ` · ${x.enviadas} ${x.enviadas === 1 ? 'enviada' : 'enviadas'}`))))
        : h('p', { class: 'panel-text' }, 'Nenhum cargo abaixo da Direção tem a permissão de avaliar.'),
      lastReminder && h('p', { class: 'staff-meta', id: 'eval-last-reminder' },
        `Último lembrete: ${lastReminder.kind === 'abertura' ? 'abertura' : 'quem não avaliou'}, ${formatDate(lastReminder.sent_at, { time: true })}, por ${lastReminder.sent_by_name ?? lastReminder.sent_by} (${lastReminder.sent} ${lastReminder.sent === 1 ? 'recebeu' : 'receberam'}).`),
      r.manage && h('div', { class: 'panel-actions' },
        h('button', { type: 'button', class: 'btn btn--sm', id: 'eval-remind-open', disabled: evaluators.length ? null : true, onclick: () => remind('abertura') }, icon('send'), 'Avisar abertura'),
        h('button', { type: 'button', class: 'btn btn--sm btn--primary', id: 'eval-remind-idle', disabled: c.idleEvaluators.length ? null : true, onclick: () => remind('pendentes') }, icon('bell'), 'Lembrar quem ainda não avaliou')));
  }

  /* ---------- exportar um período (plano 12) ---------- */
  function exportBox(list, periods, staff, decisions) {
    const sel = h('select', { class: 'input input--sm', id: 'eval-export-period' }, periods.map((p) => h('option', { value: p.id }, p.title)));
    const roleOf = (id) => roleLabel(staff.find((m) => m.discord_id === id)?.role) || '';
    const rowsOf = () => {
      const period = periods.find((p) => p.id === sel.value);
      return { period, rows: periodExportRows(period, list, decisions ?? [], roleOf) };
    };
    const slug = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'periodo';
    const save = (ext) => {
      const { period, rows } = rowsOf();
      if (!rows.length) { toast('Nenhuma avaliação enviada neste período.'); return; }
      const name = `avaliacoes-${slug(period.title)}-${brToday()}.${ext}`;
      if (ext === 'csv') downloadText(name, String.fromCharCode(0xFEFF) + periodCsv(rows), 'text/csv;charset=utf-8');
      else downloadText(name, periodMarkdown(period, rows), 'text/markdown;charset=utf-8');
    };
    return h('div', { class: 'eval-export', id: 'eval-export' },
      h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Exportar o período'), sel),
      h('button', { type: 'button', class: 'btn btn--sm', id: 'eval-export-csv', onclick: () => save('csv') }, icon('file-spreadsheet'), 'CSV'),
      h('button', { type: 'button', class: 'btn btn--sm', id: 'eval-export-md', onclick: () => save('md') }, icon('file-text'), 'Markdown'));
  }

  /* ---------- períodos (avaliacoes.gerenciar) ---------- */
  function periodsSection(periods) {
    const now = new Date();
    const titleIn = h('input', { class: 'input', id: 'period-title', maxlength: EVALUATION_LIMITS.title, value: `Avaliação de ${now.toLocaleString('pt-BR', { month: 'long', year: 'numeric' })}` });
    const startIn = h('input', { class: 'input', id: 'period-start', type: 'datetime-local', value: toLocalInput(now.toISOString()) });
    const endIn = h('input', { class: 'input', id: 'period-end', type: 'datetime-local', value: toLocalInput(new Date(now.getTime() + PERIOD_DEFAULT_DAYS * 864e5).toISOString()) });
    const notify = plus(app) && h('input', { type: 'checkbox', id: 'period-notify' });
    const form = h('form', { class: 'staff-form', id: 'period-form', novalidate: true },
      h('div', { class: 'staff-form-grid' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'period-title' }, 'Nome do período'), titleIn),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'period-start' }, 'Abre em'), startIn),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'period-end' }, 'Fecha em'), endIn,
          h('p', { class: 'field-hint' }, `Padrão: ${PERIOD_DEFAULT_DAYS} dias.`))),
      notify && h('label', { class: 'check' }, notify, ' Avisar no privado quem avalia (pelo bot, só se o período já abrir agora)'),
      h('div', { class: 'panel-actions' }, h('button', { type: 'submit', class: 'btn btn--primary', 'data-requires-online': '' }, icon('calendar-plus'), 'Abrir período')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await app.adapter.saveEvaluationPeriod({ title: titleIn.value, starts_at: fromLocalInput(startIn.value), ends_at: fromLocalInput(endIn.value) });
      if (res.error) { toast(Object.values(res.error.details?.errors ?? {})[0] ?? res.error.message, 4000); return; }
      toast(`Período "${res.data.title}" salvo.`);
      if (notify?.checked && isPeriodOpen(res.data)) {
        const sent = await app.adapter.sendEvaluationReminder({ period_id: res.data.id, kind: 'abertura', siteUrl: location.href.split('#')[0] });
        if (sent.error) toast(`O período abriu, mas o aviso no privado falhou: ${errorOf(sent.error)}`, 6000);
        else toast(`✓ Aviso de abertura enviado no privado para ${sent.data.dm?.sent ?? 0}.`, 4000);
      } else if (notify?.checked) {
        toast('O período ainda não abriu: use "Avisar abertura" na cobertura quando ele começar.', 5000);
      }
      load();
    });

    return h('section', { class: 'panel', 'aria-labelledby': 'periods-title' },
      h('h2', { class: 'block-title', id: 'periods-title' }, icon('calendar'), 'Períodos de avaliação'),
      h('p', { class: 'panel-text' }, 'O Head Staff só cria e envia avaliações enquanto um período está aberto. Depois de enviar, tem 24 horas para corrigir.'),
      form,
      h('ul', { class: 'staff-list', id: 'period-list' }, periods.length ? periods.map((p) => {
        const st = periodState(p);
        return h('li', { class: 'staff-row' },
          h('div', { class: 'staff-who' }, h('p', { class: 'staff-name' }, p.title),
            h('p', { class: 'staff-meta' }, `${formatDate(p.starts_at, { time: true })} até ${formatDate(p.ends_at, { time: true })}`)),
          h('div', { class: 'staff-tags' }, h('span', { class: `badge ${st.cls}` }, st.label)),
          st.label === 'Aberto' && h('div', { class: 'staff-actions' }, h('button', {
            type: 'button', class: 'btn btn--sm', 'data-requires-online': '', 'aria-label': `Encerrar agora ${p.title}`,
            onclick: async () => {
              const ok = await confirmDialog({ title: `Encerrar "${p.title}" agora?`, message: 'O Head Staff deixa de criar e enviar avaliações neste período. Rascunhos não enviados ficam parados.', confirmLabel: 'Encerrar agora', danger: true });
              if (!ok) return;
              const res = await app.adapter.saveEvaluationPeriod({ id: p.id, title: p.title, starts_at: p.starts_at, ends_at: new Date(Math.max(Date.now(), new Date(p.starts_at).getTime() + 60_000)).toISOString() });
              if (res.error) { app.reportError(res.error); return; }
              toast('Período encerrado.');
              load();
            },
          }, 'Encerrar agora')));
      }) : h('li', { class: 'staff-empty' }, 'Nenhum período criado ainda.')));
  }

  /* ---------- critérios (avaliacoes.gerenciar) ---------- */
  function criteriaSection(criteria) {
    const newIn = h('input', { class: 'input', id: 'criterion-new', maxlength: EVALUATION_LIMITS.label, placeholder: 'Ex.: Pontualidade nos eventos' });
    const save = async (c, patch) => {
      const res = await app.adapter.saveEvaluationCriterion({ ...c, ...patch });
      if (res.error) { toast(Object.values(res.error.details?.errors ?? {})[0] ?? res.error.message, 4000); return false; }
      return true;
    };
    return h('section', { class: 'panel', 'aria-labelledby': 'criteria-title' },
      h('h2', { class: 'block-title', id: 'criteria-title' }, icon('list-check'), 'Critérios avaliados'),
      h('p', { class: 'panel-text' }, 'Notas de 1 a 5 em cada critério ativo. Mudar a lista não altera avaliações já feitas.'),
      h('ul', { class: 'staff-list', id: 'criteria-list' }, criteria.map((c) => {
        const label = h('input', { class: 'input input--sm', value: c.label, maxlength: EVALUATION_LIMITS.label, 'aria-label': `Nome do critério ${c.label}` });
        return h('li', { class: `staff-row${c.active ? '' : ' staff-row--off'}` },
          h('div', { class: 'staff-who' }, label),
          h('div', { class: 'staff-tags' }, h('span', { class: `badge ${c.active ? 'badge--status' : 'badge--revisar'}` }, c.active ? 'Ativo' : 'Desativado')),
          h('div', { class: 'staff-actions' },
            h('button', { type: 'button', class: 'btn btn--sm', 'data-requires-online': '', onclick: async () => { if (await save(c, { label: label.value })) { toast('Critério salvo.'); load(); } } }, 'Salvar'),
            h('button', { type: 'button', class: 'btn btn--sm btn--ghost', 'data-requires-online': '', onclick: async () => { if (await save(c, { active: !c.active })) load(); } }, c.active ? 'Desativar' : 'Ativar')));
      })),
      h('form', { class: 'inline-form', id: 'criterion-form', onsubmit: async (e) => {
        e.preventDefault();
        if (await save({}, { label: newIn.value })) { toast('Critério incluído.'); load(); }
      } },
      h('label', { class: 'sr-only', for: 'criterion-new' }, 'Novo critério'), newIn,
      h('button', { type: 'submit', class: 'btn', 'data-requires-online': '' }, icon('plus'), 'Incluir critério')));
  }

  load();
  return () => { alive = false; };
}

/* ============================ uma avaliação ============================ */
export function renderEvaluation(app, id) {
  if (denied(app)) return null;
  const r = roles(app);
  const me = app.state.staff.discord_id;
  let alive = true;
  let dirty = false;
  let draft = null;
  const title = h('h1', { class: 'page-title', tabindex: '-1' }, id === 'nova' ? 'Nova avaliação' : 'Avaliação');
  const body = h('div', {}, h('p', { class: 'panel-text' }, 'Carregando…'));
  app.els.main.replaceChildren(h('div', { class: 'main-inner evaluation-page' },
    h('a', { class: 'back', href: '#/avaliacoes-equipe' }, icon('arrow-left'), 'Voltar para as avaliações'),
    h('header', { class: 'page-head' }, title),
    body));

  (async () => {
    const [periods, criteria, evaluations, members] = await Promise.all([
      app.adapter.listEvaluationPeriods(), app.adapter.listEvaluationCriteria(), app.adapter.listEvaluations(),
      r.create ? app.adapter.listEvaluableMembers() : Promise.resolve({ data: [], error: null }),
    ]);
    if (!alive) return;
    const err = [periods, criteria, evaluations, members].find((x) => x.error);
    if (err) { app.reportError(err.error, 'Não foi possível carregar a avaliação.'); return; }
    const existing = id === 'nova' ? null : evaluations.data.find((e) => e.id === id);
    if (id !== 'nova' && !existing) {
      title.textContent = 'Avaliação não encontrada';
      body.replaceChildren(h('p', { class: 'panel-text' }, 'Ela não existe ou seu cargo não pode lê-la.'));
      return;
    }
    const editable = existing
      ? existing.evaluator_id === me && (existing.status === 'rascunho' || withinEditWindow(existing))
      : r.create;
    if (editable) renderForm(existing, periods.data, criteria.data, members.data);
    else renderRead(existing, periods.data);
  })();

  /* ---------- leitura (Direção, ou o autor depois das 24 horas) ---------- */
  async function renderRead(e, periods) {
    title.textContent = `Avaliação de ${e.evaluated_name ?? e.evaluated_id}`;
    // Plano 12: o que a Direção decidiu sobre a recomendação (só quem abre o Painel da Diretoria).
    const decisionsBox = plus(app) && app.can('diretoria.ver') && e.evaluator_id !== me && e.recommendation
      ? h('section', { class: 'panel', id: 'eval-decisions', 'aria-labelledby': 'eval-decisions-title' },
        h('h2', { class: 'block-title', id: 'eval-decisions-title' }, icon('gavel'), 'Decisão da Direção'),
        h('p', { class: 'panel-text' }, 'Carregando…'))
      : null;
    if (decisionsBox) {
      app.adapter.listEvaluationDecisions().then((res) => {
        if (!alive || !decisionsBox.isConnected) return;
        const list = res.error ? [] : res.data.filter((d) => d.evaluation_id === e.id);
        decisionsBox.replaceChildren(decisionsBox.firstChild,
          list.length
            ? h('ol', { class: 'plain-list eval-decision-list' }, list.map((d) => h('li', {},
              h('strong', {}, decisionLabel(d.decision)), d.action ? ` · ${recommendationLabel(d.action)}` : '',
              h('span', { class: 'staff-meta' }, ` · ${d.decided_by_name ?? d.decided_by}, ${formatDate(d.decided_at, { time: true })}`),
              h('p', { class: 'pre-wrap' }, d.reason))))
            : h('p', { class: 'panel-text' }, 'Ainda sem decisão registrada.'),
          h('p', {}, h('a', { class: 'btn btn--sm', id: 'eval-open-decision', href: `#/diretoria/decisoes/${e.evaluated_id}` }, icon('gavel'), 'Abrir a ficha de decisão no painel')));
      });
    }
    const period = periods.find((p) => p.id === e.period_id);
    const text = (label, value) => value && h('section', { class: 'panel' }, h('h2', { class: 'block-title' }, label), h('p', { class: 'pre-wrap' }, value));
    body.replaceChildren(...[
      h('p', { class: 'staff-meta', id: 'eval-meta' },
        `${period?.title ?? ''} · avaliada por ${e.evaluator_name ?? e.evaluator_id}`,
        e.submitted_at && ` em ${formatDate(e.submitted_at, { time: true })}`,
        e.status === 'arquivada' && ' · arquivada'),
      r.read && e.evaluator_id !== me && h('p', {}, h('a', { href: `#/equipe/${e.evaluated_id}` }, 'Abrir a ficha do membro')),
      h('section', { class: 'panel', 'aria-labelledby': 'eval-scores-title' },
        h('h2', { class: 'block-title', id: 'eval-scores-title' }, icon('star'), 'Notas'),
        h('dl', { class: 'member-data', id: 'eval-scores' },
          e.criteria.map((c) => h('div', { class: 'member-row' }, h('dt', {}, c.label),
            h('dd', { 'aria-label': `${c.score ?? 'sem nota'} de 5` }, h('span', { class: 'stars' }, stars(c.score)),
              c.comment && h('span', { class: 'eval-crit-comment' }, c.comment),
              c.evidence?.length > 0 && h('span', { class: 'eval-crit-links' }, c.evidence.map((l, i) =>
                h('a', { href: /^https:\/\//.test(l) ? l : '#', target: '_blank', rel: 'noopener noreferrer' }, `Evidência ${i + 1}`)))))),
          h('div', { class: 'member-row' }, h('dt', {}, h('strong', {}, 'Nota geral')),
            h('dd', { 'aria-label': `${e.overall ?? 'sem nota'} de 5` }, h('span', { class: 'stars stars--lg' }, stars(e.overall)))),
          h('div', { class: 'member-row' }, h('dt', {}, 'Recomendação'), h('dd', {}, recommendationLabel(e.recommendation) || '(não informada)')))),
      e.justification && h('section', { class: 'panel eval-justification', id: 'eval-justification' },
        h('h2', { class: 'block-title' }, icon('alert-triangle'), 'Justificativa da recomendação'), h('p', { class: 'pre-wrap' }, e.justification)),
      text('Pontos fortes', e.strengths),
      text('Pontos a melhorar', e.improvements),
      text('Feedback e observações', e.feedback),
      decisionsBox,
      r.manage && e.status === 'enviada' && e.evaluator_id !== me && h('div', { class: 'panel-actions' },
        h('button', { type: 'button', class: 'btn btn--danger', id: 'eval-archive', 'data-requires-online': '', onclick: async () => {
          const ok = await confirmDialog({ title: 'Arquivar a avaliação?', message: 'Ela sai da caixa de novas e fica marcada como arquivada. Continua registrada.', confirmLabel: 'Arquivar', danger: true });
          if (!ok) return;
          const res = await app.adapter.archiveEvaluation(e.id);
          if (res.error) { app.reportError(res.error); return; }
          toast('Avaliação arquivada.');
          app.router.go('#/avaliacoes-equipe');
        } }, icon('archive'), 'Arquivar')),
    ].filter(Boolean));
    app.applyOnline();
    if (r.read && e.evaluator_id !== me && e.status === 'enviada' && !e.read_at) {
      await app.adapter.markEvaluationRead(e.id);
      app.refreshCounts();
    }
  }

  /* ---------- formulário (criar, rascunho, enviar e corrigir em 24 h) ---------- */
  function renderForm(e, periods, criteria, members, recovered = null) {
    const now = Date.now();
    const notes = plus(app);
    const open = periods.filter((p) => isPeriodOpen(p, now));
    if (!e && !open.length) {
      body.replaceChildren(h('div', { class: 'banner banner--info' }, icon('calendar-off'), h('p', {}, 'Nenhum período de avaliação aberto. Aguarde a Direção abrir um período.')));
      return;
    }
    const sent = e?.status === 'enviada';
    // Critérios: os da própria avaliação (cópia) ou os ativos agora.
    const rows = (recovered?.rows ?? (e?.criteria?.length ? e.criteria : criteria.filter((c) => c.active).map((c) => ({ id: c.id, label: c.label, score: null }))))
      .map((c) => ({ ...c, comment: c.comment ?? '', evidence: Array.isArray(c.evidence) ? [...c.evidence] : [] }));
    const state = {
      period_id: e?.period_id ?? open[0].id, evaluated_id: e?.evaluated_id ?? '', overall: e?.overall ?? null,
      recommendation: e?.recommendation ?? '', strengths: e?.strengths ?? '', improvements: e?.improvements ?? '', feedback: e?.feedback ?? '',
      justification: e?.justification ?? '',
      ...(recovered?.state ?? {}),
    };
    // Rascunho automático (js/ui/draft.js): notas, textos e escolhas, por avaliação.
    draft?.stop();
    draft = createDraft(app, `avaliacao-equipe:${e?.id ?? 'nova'}`, {
      read: () => ({ state: { ...state }, rows: rows.map(({ id: cid, label, score, comment, evidence }) => ({ id: cid, label, score, comment, evidence })) }),
      hasContent: (v) => Boolean(v.state?.evaluated_id) || v.rows?.some((c) => c.score != null || c.comment)
        || ['strengths', 'improvements', 'feedback', 'justification'].some((k) => String(v.state?.[k] ?? '').trim()),
      ...(recovered ? { initial: { state: {}, rows: [] } } : {}),
    });
    const draftBanner = recovered ? null : draft.banner((data) => renderForm(e, periods, criteria, members, data), { id: 'eval-draft-banner' });
    if (recovered) dirty = true;
    title.textContent = e ? `Avaliação de ${e.evaluated_name ?? e.evaluated_id}` : 'Nova avaliação';
    const touch = () => { dirty = true; };

    const memberSel = h('select', { class: 'input', id: 'eval-member', disabled: sent, onchange: (ev) => { state.evaluated_id = ev.target.value; touch(); showProductivity(); } },
      h('option', { value: '' }, 'Escolha o membro'),
      (e && !members.some((m) => m.discord_id === e.evaluated_id) ? [{ discord_id: e.evaluated_id, display_name: e.evaluated_name ?? e.evaluated_id, role: '' }] : [])
        .concat(members).map((m) => h('option', { value: m.discord_id, selected: m.discord_id === state.evaluated_id }, `${m.display_name}${m.role ? ` (${roleLabel(m.role)})` : ''}`)));
    const periodSel = h('select', { class: 'input', id: 'eval-period-select', disabled: sent, onchange: (ev) => { state.period_id = ev.target.value; touch(); } },
      (sent ? periods.filter((p) => p.id === state.period_id) : open).map((p) => h('option', { value: p.id, selected: p.id === state.period_id }, p.title)));

    const overallSel = h('select', { class: 'input', id: 'eval-overall', onchange: (ev) => { state.overall = ev.target.value ? Number(ev.target.value) : null; touch(); } },
      h('option', { value: '' }, 'Escolha'), [5, 4, 3, 2, 1].map((n) => h('option', { value: n, selected: n === state.overall }, `${n} · ${stars(n)}`)));
    const suggestion = h('p', { class: 'field-hint', id: 'eval-overall-hint' });
    const updateSuggestion = () => {
      const s = suggestedOverall(rows);
      suggestion.textContent = s ? `Média das notas: ${s}. Você pode ajustar.` : 'Dê nota a todos os critérios para ver a média sugerida.';
      if (s && state.overall == null) { state.overall = s; overallSel.value = String(s); }
    };

    const scoreField = (c, i) => h('fieldset', { class: 'score-field', id: `eval-c-${i}` },
      h('legend', { class: 'field-label' }, c.label),
      h('div', { class: 'score-options' }, [1, 2, 3, 4, 5].map((n) => h('label', { class: 'score-option' },
        h('input', { type: 'radio', name: `eval-c-${i}`, value: n, checked: c.score === n, onchange: () => { c.score = n; touch(); updateSuggestion(); } }),
        h('span', { 'aria-hidden': 'true' }, `${n} ★`), h('span', { class: 'sr-only' }, `${n} de 5`)))),
      // Plano 12: comentário curto e links de evidência (um por linha), opcionais.
      notes && h('details', { class: 'eval-crit-notes', open: Boolean(c.comment || c.evidence.length) || null },
        h('summary', {}, 'Comentário e evidências (opcional)'),
        h('label', { class: 'field-label', for: `eval-c-${i}-comment` }, 'Comentário'),
        h('input', { class: 'input input--sm', id: `eval-c-${i}-comment`, maxlength: CRITERION_LIMITS.comment, value: c.comment,
          oninput: (ev) => { c.comment = ev.target.value; touch(); } }),
        h('label', { class: 'field-label', for: `eval-c-${i}-evidence` }, 'Links de evidência (um por linha, até 5)'),
        h('textarea', { class: 'input', id: `eval-c-${i}-evidence`, rows: 2, placeholder: 'https://discord.com/channels/...',
          oninput: (ev) => { c.evidence = parseEvidence(ev.target.value); touch(); } }, c.evidence.join('\n'))));

    const area = (key, label, max, rowsN) => h('div', { class: 'field' },
      h('label', { class: 'field-label', for: `eval-${key}` }, label),
      h('textarea', { class: 'input', id: `eval-${key}`, rows: rowsN, maxlength: max, oninput: (ev) => { state[key] = ev.target.value; touch(); } }, state[key]));
    const recSel = h('select', { class: 'input', id: 'eval-recommendation', onchange: (ev) => { state.recommendation = ev.target.value; touch(); syncJustification(); } },
      h('option', { value: '' }, 'Escolha'), RECOMMENDATIONS.map((x) => h('option', { value: x.code, selected: x.code === state.recommendation }, x.label)));
    const errorEl = h('p', { class: 'field-error form-general-error', role: 'alert', tabindex: '-1', hidden: true });

    // Plano 12: advertência e desligamento exigem justificativa (mínimo de 100 caracteres ao enviar).
    const justCount = h('p', { class: 'field-hint', id: 'eval-justification-count', 'aria-live': 'polite' });
    const justIn = h('textarea', { class: 'input', id: 'eval-justification', rows: 4, maxlength: JUSTIFICATION_MAX,
      oninput: (ev) => { state.justification = ev.target.value; touch(); paintJust(); } }, state.justification);
    const paintJust = () => {
      const n = state.justification.trim().length;
      justCount.textContent = n >= JUSTIFICATION_MIN ? `✓ ${n} caracteres` : `${n} de no mínimo ${JUSTIFICATION_MIN} caracteres`;
    };
    const justBox = notes && h('div', { class: 'field eval-justification-field', id: 'eval-justification-box' },
      h('label', { class: 'field-label', for: 'eval-justification' }, 'Justificativa da recomendação *'),
      h('p', { class: 'field-hint' }, 'Obrigatória para advertência e desligamento. Explique o que aconteceu e por que essa é a recomendação.'),
      justIn, justCount);
    const syncJustification = () => { if (justBox) justBox.hidden = !needsJustification(state.recommendation); };
    paintJust();
    syncJustification();

    // Plano 12: produtividade do avaliado nos últimos 30 dias (só para quem vê o painel de produtividade).
    const prodBox = h('div', { class: 'eval-prod', id: 'eval-productivity', 'aria-live': 'polite' });
    let prod = null;
    async function showProductivity() {
      if (!notes || !app.feature('produtividade') || !app.can('produtividade.ver')) return;
      if (!state.evaluated_id) { prodBox.replaceChildren(); return; }
      if (!prod) {
        prodBox.replaceChildren(h('p', { class: 'panel-text' }, 'Carregando a produtividade…'));
        const to = new Date(Date.now() + 86400_000);
        const res = await app.adapter.getProductivity({ from: new Date(to.getTime() - 31 * 86400_000).toISOString(), to: to.toISOString() });
        if (!alive) return;
        prod = res.error ? { members: [] } : res.data;
      }
      const m = prod.members.find((x) => x.discord_id === state.evaluated_id);
      prodBox.replaceChildren(h('p', { class: 'banner banner--info' }, icon('chart-bar'),
        h('span', {}, m
          ? `Últimos 30 dias: ${m.allowlists} ${m.allowlists === 1 ? 'allowlist' : 'allowlists'} (${m.allowlists_aprovadas} aprovadas), ${m.entrevistas} ${m.entrevistas === 1 ? 'entrevista' : 'entrevistas'} e ${m.acompanhamentos} ${m.acompanhamentos === 1 ? 'acompanhamento' : 'acompanhamentos'}.${m.last_at ? ` Última atividade em ${formatDate(m.last_at)}.` : ''}`
          : 'Últimos 30 dias: nenhuma allowlist nem entrevista registrada na Central.')));
    }

    const payload = (status) => ({
      id: e?.id, period_id: state.period_id, evaluated_id: state.evaluated_id, status,
      criteria: rows.map(({ id: cid, label, score, comment, evidence }) => (notes ? { id: cid, label, score, comment, evidence } : { id: cid, label, score })),
      overall: state.overall, recommendation: state.recommendation || null,
      strengths: state.strengths, improvements: state.improvements, feedback: state.feedback,
      ...(notes ? { justification: state.justification } : {}),
    });

    async function submit(status) {
      if (!state.evaluated_id) { errorEl.textContent = 'Escolha o membro avaliado.'; errorEl.hidden = false; memberSel.focus(); return; }
      if (status === 'enviada' && !sent) {
        const ok = await confirmDialog({
          title: 'Enviar a avaliação?',
          message: 'Depois de enviada, a avaliação só pode ser lida pela Direção (Resp. Equipe, Administradores e CEO). Você terá 24 horas para corrigir; depois disso, só poderá lê-la.',
          confirmLabel: 'Enviar',
        });
        if (!ok) return;
      }
      const res = await app.adapter.saveEvaluation(payload(status));
      if (!alive) return;
      if (res.error) {
        errorEl.textContent = res.error.details?.errors?._ ?? Object.values(res.error.details?.errors ?? {})[0] ?? res.error.message;
        errorEl.hidden = false;
        errorEl.focus();
        return;
      }
      dirty = false;
      draft.clear();
      app.router.clearGuard();
      toast(status === 'enviada' ? (sent ? 'Correção salva.' : 'Avaliação enviada para a Direção.') : 'Rascunho salvo.');
      if (status === 'rascunho' && !e) app.router.go(`#/avaliacoes-equipe/${res.data.id}`);
      else app.router.go('#/avaliacoes-equipe');
    }

    async function removeDraft() {
      const ok = await confirmDialog({ title: 'Apagar o rascunho?', message: 'O rascunho some e não pode ser recuperado.', confirmLabel: 'Apagar', danger: true });
      if (!ok) return;
      const res = await app.adapter.deleteEvaluation(e.id);
      if (res.error) { app.reportError(res.error); return; }
      dirty = false;
      draft.clear();
      app.router.clearGuard();
      toast('Rascunho apagado.');
      app.router.go('#/avaliacoes-equipe');
    }

    body.replaceChildren(h('form', { class: 'eval-form', id: 'eval-form', novalidate: true, onsubmit: (ev) => { ev.preventDefault(); submit('enviada'); } },
      draftBanner,
      sent && h('div', { class: 'banner banner--warn' }, icon('clock'),
        h('p', {}, `Avaliação enviada. Você pode corrigir até ${formatDate(new Date(new Date(e.submitted_at).getTime() + EDIT_WINDOW_MS).toISOString(), { time: true })}; depois disso, só ler.`)),
      h('div', { class: 'staff-form-grid' },
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'eval-member' }, 'Membro avaliado *'), memberSel,
          h('p', { class: 'field-hint' }, 'Só aparecem membros de cargo abaixo do seu.')),
        h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'eval-period-select' }, 'Período *'), periodSel)),
      prodBox,
      h('section', { class: 'panel', 'aria-labelledby': 'eval-criteria-title' },
        h('h2', { class: 'block-title', id: 'eval-criteria-title' }, icon('star'), 'Notas de 1 a 5'),
        rows.map(scoreField),
        h('div', { class: 'staff-form-grid' },
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'eval-overall' }, 'Nota geral *'), overallSel, suggestion),
          h('div', { class: 'field' }, h('label', { class: 'field-label', for: 'eval-recommendation' }, 'Recomendação *'), recSel)),
        justBox),
      area('strengths', 'Pontos fortes', EVALUATION_LIMITS.strengths, 3),
      area('improvements', 'Pontos a melhorar', EVALUATION_LIMITS.improvements, 3),
      area('feedback', 'Feedback e observações', EVALUATION_LIMITS.feedback, 5),
      errorEl,
      h('div', { class: 'form-actions' },
        e?.status === 'rascunho' && h('button', { type: 'button', class: 'btn btn--ghost btn--danger', id: 'eval-delete', 'data-requires-online': '', onclick: removeDraft }, icon('trash'), 'Apagar rascunho'),
        !sent && h('button', { type: 'button', class: 'btn', id: 'eval-save-draft', 'data-requires-online': '', onclick: () => submit('rascunho') }, icon('device-floppy'), 'Salvar rascunho'),
        h('button', { type: 'submit', class: 'btn btn--primary', id: 'eval-submit', 'data-requires-online': '' }, icon('send'), sent ? 'Salvar correção' : 'Enviar para a Direção'))));
    updateSuggestion();
    showProductivity();
    app.applyOnline();
    app.router.setGuard(async () => {
      if (!dirty) return true;
      return confirmDialog({ title: 'Sair sem salvar?', message: 'As alterações na avaliação ainda não foram salvas.', confirmLabel: 'Sair sem salvar', cancelLabel: 'Continuar', danger: true });
    });
  }

  return () => { alive = false; draft?.stop(); app.router.clearGuard(); };
}
