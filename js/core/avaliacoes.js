// Plano 12 · Avaliações da equipe integradas ao Painel da Diretoria (decisões da Lai no plano 12).
// Regras puras: justificativa das recomendações graves, comentário e evidências por critério,
// decisões da Direção, cobertura do período, evolução por critério e exportação.
// Quem garante é o banco (supabase/23_avaliacoes_decisoes.sql); tests/db/banco.test.mjs confere as mensagens.
import { RECOMMENDATIONS, recommendationLabel } from './workflow.js';
import { DIRECTION_LEVEL, roleLevel } from './permissions.js';

export const EVALUATION_DECISION_ERRORS = Object.freeze({
  justification: 'Advertência e desligamento exigem justificativa de pelo menos 100 caracteres.',
  noAccess: 'Seu cargo não permite abrir o Painel da Diretoria.',
  notFound: 'Avaliação não encontrada.',
  self: 'Você não pode decidir sobre a sua própria avaliação.',
  above: 'Você só pode decidir sobre membros de cargo abaixo do seu.',
  decision: 'Decisão inválida.',
  action: 'Escolha o que a Direção decidiu fazer.',
  sameAction: 'A decisão é igual à recomendação: marque "Acatada".',
  reason: 'Explique o motivo da decisão (de 10 a 1000 caracteres).',
  coverage: 'Seu cargo não permite ver a cobertura das avaliações.',
});

/* ---------------------------------------------------------------------------
 * Justificativa das recomendações graves (Decisão 5: no mínimo 100 caracteres)
 * ------------------------------------------------------------------------- */
export const JUSTIFICATION_MIN = 100;
export const JUSTIFICATION_MAX = 2000;
export const GRAVE_RECOMMENDATIONS = Object.freeze(['advertencia', 'desligamento']);
export const needsJustification = (recommendation) => GRAVE_RECOMMENDATIONS.includes(recommendation);

/** Erro da justificativa (o mínimo só vale ao enviar). null = ok. */
export function justificationError({ status, recommendation, justification = '' }) {
  const text = String(justification ?? '');
  if (text.length > JUSTIFICATION_MAX) return `Justificativa: até ${JUSTIFICATION_MAX} caracteres.`;
  if (status !== 'enviada' || !needsJustification(recommendation)) return null;
  return text.trim().length < JUSTIFICATION_MIN ? EVALUATION_DECISION_ERRORS.justification : null;
}

/* ---------------------------------------------------------------------------
 * Comentário e evidências por critério (iguais ao kb_valid_eval_criteria_notes do 23)
 * ------------------------------------------------------------------------- */
export const CRITERION_LIMITS = Object.freeze({ comment: 500, evidence: 5, link: 300 });
const LINK = /^https:\/\/\S+$/;

/** Textarea "um link por linha" → lista limpa (sem linhas vazias). */
export const parseEvidence = (text) => String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

/** Confere comentário e evidências de cada critério. Devolve a mensagem ou null. */
export function criteriaNotesError(criteria = []) {
  for (const c of criteria ?? []) {
    if (c?.comment != null && (typeof c.comment !== 'string' || c.comment.length > CRITERION_LIMITS.comment)) {
      return `Comentário de "${c.label}": até ${CRITERION_LIMITS.comment} caracteres.`;
    }
    if (c?.evidence != null) {
      if (!Array.isArray(c.evidence) || c.evidence.length > CRITERION_LIMITS.evidence) {
        return `Evidências de "${c.label}": até ${CRITERION_LIMITS.evidence} links.`;
      }
      if (c.evidence.some((l) => typeof l !== 'string' || l.length > CRITERION_LIMITS.link || !LINK.test(l))) {
        return `Evidências de "${c.label}": use links completos começando com https://.`;
      }
    }
  }
  return null;
}

/** Critério para gravar: id, label, score e, quando preenchidos (e com notes), comment e evidence. */
export function pickCriterion(c, { notes = true } = {}) {
  const out = { id: c.id, label: c.label, score: c.score ?? null };
  if (!notes) return out;
  const comment = String(c.comment ?? '').trim();
  const evidence = Array.isArray(c.evidence) ? c.evidence.map((l) => String(l).trim()).filter(Boolean) : [];
  if (comment) out.comment = comment;
  if (evidence.length) out.evidence = evidence;
  return out;
}

/* ---------------------------------------------------------------------------
 * Decisões da Direção (Decisões 2 e 3)
 * ------------------------------------------------------------------------- */
export const DECISIONS = Object.freeze([
  Object.freeze({ code: 'acatada', label: 'Acatada' }),
  Object.freeze({ code: 'outra', label: 'Outra decisão' }),
  Object.freeze({ code: 'adiada', label: 'Adiada' }),
]);
export const decisionLabel = (code) => DECISIONS.find((d) => d.code === code)?.label ?? '';
export const DECISION_REASON = Object.freeze({ min: 10, max: 1000 });

/** Mesma regra de alvo do banco (kb_diretoria_alvo_erro): nunca sobre si, só cargo abaixo (o CEO, todos). */
export function decisionTargetError(actor, target) {
  if (!target || !target.active) return 'Membro não encontrado ou inativo.';
  if (target.discord_id === actor.discord_id) return EVALUATION_DECISION_ERRORS.self;
  if (actor.role !== 'ceo' && roleLevel(target.role) >= roleLevel(actor.role)) return EVALUATION_DECISION_ERRORS.above;
  return null;
}

/** A ação que fica registrada: acatada = a recomendação; adiada = nenhuma; outra = a escolhida. */
export function resolvedAction(evaluation, decision, action) {
  if (decision === 'acatada') return evaluation?.recommendation ?? null;
  if (decision === 'adiada') return null;
  return action || null;
}

/** Mesmas travas de registrar_decisao_avaliacao (menos permissão e alvo). { valid, errors }. */
export function validateDecision(evaluation, { decision, action, reason } = {}) {
  const errors = {};
  if (!DECISIONS.some((d) => d.code === decision)) errors.decision = EVALUATION_DECISION_ERRORS.decision;
  else if (decision === 'outra') {
    if (!RECOMMENDATIONS.some((r) => r.code === action)) errors.action = EVALUATION_DECISION_ERRORS.action;
    else if (action === evaluation?.recommendation) errors.action = EVALUATION_DECISION_ERRORS.sameAction;
  }
  const text = String(reason ?? '').trim();
  if (text.length < DECISION_REASON.min || text.length > DECISION_REASON.max) errors.reason = EVALUATION_DECISION_ERRORS.reason;
  return { valid: Object.keys(errors).length === 0, errors };
}

/**
 * O que abrir depois de registrar a decisão (Decisão 3: a janela já preenchida, sempre com confirmação).
 * promover → trocar cargo; advertência e desligamento → ocorrência do mesmo tipo; acompanhar → alinhamento.
 */
export function decisionFollowUp(action) {
  if (action === 'promover') return { kind: 'cargo', label: 'Alterar cargo' };
  if (action === 'advertencia') return { kind: 'ocorrencia', tipo: 'advertencia', label: 'Registrar advertência' };
  if (action === 'desligamento') return { kind: 'ocorrencia', tipo: 'desligamento', label: 'Registrar desligamento' };
  if (action === 'acompanhar') return { kind: 'alinhamento', label: 'Chamar para alinhamento' };
  return null;
}

/** Texto sugerido para a ocorrência ou o alinhamento aberto a partir da decisão. */
export function followUpText(evaluation, reason) {
  const rec = recommendationLabel(evaluation?.recommendation) || 'sem recomendação';
  return `Decisão sobre a avaliação do Head Staff (recomendação: ${rec}). ${String(reason ?? '').trim()}`.trim().slice(0, 1000);
}

/** A decisão mais recente de cada avaliação: Map(evaluation_id → decisão). */
export function latestDecisions(decisions = []) {
  const map = new Map();
  for (const d of [...decisions].sort((a, b) => a.decided_at.localeCompare(b.decided_at))) map.set(d.evaluation_id, d);
  return map;
}

/** Avaliações enviadas que ainda esperam a Direção (sem decisão, ou adiadas). Mais antigas primeiro. */
export function pendingDecisions(evaluations = [], decisions = []) {
  const last = latestDecisions(decisions);
  return evaluations
    .filter((e) => e.status !== 'rascunho' && e.recommendation && (!last.has(e.id) || last.get(e.id).decision === 'adiada'))
    .sort((a, b) => String(a.submitted_at ?? '').localeCompare(String(b.submitted_at ?? '')));
}

/* ---------------------------------------------------------------------------
 * Cobertura do período (quem recebe os lembretes: evaluationReminderRecipients em allowlist.js)
 * ------------------------------------------------------------------------- */
/** "faltam 2 dias e 3 h" / "faltam 5 h e 10 min" / "faltam 40 min" / "encerrado". */
export function timeLeftLabel(endsAt, now = Date.now()) {
  const ms = new Date(endsAt).getTime() - now;
  if (!(ms > 0)) return 'encerrado';
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  if (days) return `faltam ${days} ${days === 1 ? 'dia' : 'dias'}${hours ? ` e ${hours} h` : ''}`;
  if (hours) return `faltam ${hours} h${min % 60 ? ` e ${min % 60} min` : ''}`;
  return `faltam ${Math.max(1, min)} min`;
}

/**
 * Cobertura de um período: quem ainda não recebeu avaliação (ativos abaixo da Direção) e quem avalia sem ter
 * enviado nenhuma. `evaluators` vem de avaliacao_cobertura.
 */
export function periodCoverage({ period, evaluations = [], staff = [], evaluators = [], now = Date.now() }) {
  if (!period) return null;
  const sent = evaluations.filter((e) => e.period_id === period.id && e.status !== 'rascunho');
  const evaluable = staff.filter((m) => m.active && roleLevel(m.role) > 0 && roleLevel(m.role) < DIRECTION_LEVEL);
  const notEvaluated = evaluable.filter((m) => !sent.some((e) => e.evaluated_id === m.discord_id));
  return {
    total: evaluable.length,
    evaluated: evaluable.length - notEvaluated.length,
    notEvaluated,
    evaluators,
    idleEvaluators: evaluators.filter((c) => !c.enviadas),
    timeLeft: timeLeftLabel(period.ends_at, now),
    closed: new Date(period.ends_at).getTime() <= now,
  };
}

/* ---------------------------------------------------------------------------
 * Evolução por critério (períodos anteriores)
 * ------------------------------------------------------------------------- */
const average = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);

/**
 * Média de cada critério do membro em cada período (avaliações enviadas ou arquivadas), do mais antigo para o
 * mais recente. Critérios casam pelo nome (a lista pode mudar entre períodos).
 * { periods: [{ id, title }], series: [{ label, values }], overall: [média da nota geral por período] }.
 */
export function criterionEvolution(evaluations = [], periods = [], memberId) {
  const mine = evaluations.filter((e) => e.evaluated_id === memberId && e.status !== 'rascunho');
  const used = periods.filter((p) => mine.some((e) => e.period_id === p.id)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const labels = [...new Set(mine.flatMap((e) => (e.criteria ?? []).map((c) => c.label)))];
  const inPeriod = (p) => mine.filter((e) => e.period_id === p.id);
  return {
    periods: used.map((p) => ({ id: p.id, title: p.title })),
    series: labels.map((label) => ({
      label,
      values: used.map((p) => average(inPeriod(p).flatMap((e) => (e.criteria ?? [])
        .filter((c) => c.label === label && Number.isInteger(c.score)).map((c) => c.score)))),
    })),
    overall: used.map((p) => average(inPeriod(p).map((e) => e.overall).filter(Number.isInteger))),
  };
}

/** Tendência entre os dois últimos valores: 'sobe' | 'cai' | 'igual' | null. */
export function criterionTrend(values = []) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return null;
  const [a, b] = v.slice(-2);
  return b > a ? 'sobe' : b < a ? 'cai' : 'igual';
}

/* ---------------------------------------------------------------------------
 * Exportar o período (CSV e Markdown)
 * ------------------------------------------------------------------------- */
// Mesma proteção do rankingCsv (diretoria.js): nada de fórmula ao abrir no Excel.
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[";\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
};
const criteriaAverage = (e) => {
  const xs = (e.criteria ?? []).map((c) => c.score).filter(Number.isInteger);
  return xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1).replace('.', ',') : '';
};

/** Linhas do período: avaliações enviadas ou arquivadas, por nome do membro. */
export function periodExportRows(period, evaluations = [], decisions = [], roleOf = () => '') {
  const last = latestDecisions(decisions);
  const name = (e) => String(e.evaluated_name ?? e.evaluated_id);
  return evaluations.filter((e) => e.period_id === period.id && e.status !== 'rascunho')
    .sort((a, b) => name(a).localeCompare(name(b), 'pt-BR'))
    .map((e) => {
      const d = last.get(e.id);
      return {
        membro: name(e), discord_id: e.evaluated_id, cargo: roleOf(e.evaluated_id) ?? '',
        avaliador: e.evaluator_name ?? e.evaluator_id, geral: e.overall ?? '', media: criteriaAverage(e),
        recomendacao: recommendationLabel(e.recommendation), justificativa: e.justification ?? '',
        decisao: d ? decisionLabel(d.decision) : 'Pendente', acao: d?.action ? recommendationLabel(d.action) : '', motivo: d?.reason ?? '',
        situacao: e.status === 'arquivada' ? 'Arquivada' : 'Enviada',
      };
    });
}

const EXPORT_HEAD = Object.freeze([['membro', 'Membro'], ['discord_id', 'Discord ID'], ['cargo', 'Cargo'], ['avaliador', 'Avaliador'],
  ['geral', 'Nota geral (1 a 5)'], ['media', 'Média dos critérios'], ['recomendacao', 'Recomendação'], ['justificativa', 'Justificativa'],
  ['decisao', 'Decisão da Direção'], ['acao', 'Ação decidida'], ['motivo', 'Motivo'], ['situacao', 'Situação']]);

export const periodCsv = (rows) => [EXPORT_HEAD.map(([, t]) => t), ...rows.map((r) => EXPORT_HEAD.map(([k]) => r[k]))]
  .map((l) => l.map(csvCell).join(';')).join('\r\n');

export function periodMarkdown(period, rows) {
  const md = (v) => String(v ?? '').replace(/\|/g, '/').replace(/\r?\n/g, ' ').trim() || '–';
  const cols = EXPORT_HEAD.filter(([k]) => !['discord_id', 'justificativa', 'motivo'].includes(k));
  const lines = [
    `# ${md(period.title)}`, '',
    `Período: ${period.starts_at.slice(0, 10)} a ${period.ends_at.slice(0, 10)} · ${rows.length} ${rows.length === 1 ? 'avaliação' : 'avaliações'}`, '',
    `| ${cols.map(([, t]) => t).join(' | ')} |`, `| ${cols.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${cols.map(([k]) => md(r[k])).join(' | ')} |`),
  ];
  const notes = rows.filter((r) => r.justificativa || r.motivo);
  if (notes.length) {
    lines.push('', '## Justificativas e motivos', '');
    for (const r of notes) {
      lines.push(`### ${md(r.membro)} (por ${md(r.avaliador)})`, '');
      if (r.justificativa) lines.push(`- Justificativa: ${md(r.justificativa)}`);
      if (r.motivo) lines.push(`- Motivo da Direção: ${md(r.motivo)}`);
      lines.push('');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
