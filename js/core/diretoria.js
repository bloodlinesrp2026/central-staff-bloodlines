// Painel da Diretoria (plano 10): regras puras usadas pela tela, pelo mock e conferidas
// contra o banco (supabase/21_diretoria.sql; tests/db/banco.test.mjs confere as mensagens).
// Pessoas pelo Discord ID, como no resto da Central.
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';
import { CEO, roleLevel } from './permissions.js';

/** Mensagens das travas: IGUAIS às do 21_diretoria.sql. */
export const DIRETORIA_ERRORS = Object.freeze({
  member: 'Membro não encontrado ou inativo.',
  evalSelf: 'Você não pode avaliar a si mesmo.',
  evalAbove: 'Você só pode avaliar membros de cargo abaixo do seu.',
  score: 'As notas vão de 0 a 10, de meio em meio ponto.',
  period: 'O fim do período precisa ser igual ou depois do início.',
  comment: 'O comentário tem no máximo 500 caracteres.',
  occSelf: 'Você não pode registrar ocorrência sobre si mesmo.',
  occAbove: 'Você só pode registrar ocorrência de membros de cargo abaixo do seu.',
  occType: 'Tipo de ocorrência inválido.',
  occText: 'Descreva a ocorrência (até 1000 caracteres).',
  sameRole: 'O membro já tem esse cargo.',
  roleUnknown: 'Cargo inexistente.',
  reason: 'O motivo tem no máximo 300 caracteres.',
  rules: 'As regras de promoção têm no máximo 5000 caracteres.',
  noAccess: 'Seu cargo não permite abrir o Painel da Diretoria.',
  period400: 'Período inválido: a data final precisa ser depois da inicial (até 400 dias).',
});

export const DIRETORIA_LIMITS = Object.freeze({ comment: 500, occurrence: 1000, reason: 300, rules: 5000 });

/** As cinco notas da avaliação da Diretoria (0 a 10, meio em meio ponto). */
export const SCORE_FIELDS = Object.freeze([
  Object.freeze({ key: 'nota_geral', label: 'Geral' }),
  Object.freeze({ key: 'nota_presenca', label: 'Presença' }),
  Object.freeze({ key: 'nota_qualidade', label: 'Qualidade' }),
  Object.freeze({ key: 'nota_colaboracao', label: 'Colaboração' }),
  Object.freeze({ key: 'nota_iniciativa', label: 'Iniciativa' }),
]);

export const OCCURRENCE_TYPES = Object.freeze([
  Object.freeze({ code: 'advertencia', label: 'Advertência', positive: false }),
  Object.freeze({ code: 'elogio', label: 'Elogio', positive: true }),
  Object.freeze({ code: 'suspensao', label: 'Suspensão', positive: false }),
  Object.freeze({ code: 'desligamento', label: 'Desligamento', positive: false }),
]);
export const occurrenceLabel = (code) => OCCURRENCE_TYPES.find((t) => t.code === code)?.label ?? code;

export const validScore = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 10 && Number.isInteger(n * 2);

/** Média das notas (uma casa) e a faixa de desempenho mostrada abaixo dos sliders. */
export function scoreAverage(scores) {
  const values = SCORE_FIELDS.map((f) => scores?.[f.key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!values.length) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

export function scoreBand(avg) {
  if (avg == null) return null;
  if (avg < 4) return { tone: 'critico', label: 'Desempenho crítico' };
  if (avg < 7) return { tone: 'regular', label: 'Desempenho regular' };
  if (avg < 9) return { tone: 'bom', label: 'Bom desempenho' };
  return { tone: 'excepcional', label: 'Desempenho excepcional' };
}

/** Cor da barra de score da tabela: verde acima de 7, amarela de 4 a 7, vermelha abaixo de 4. */
export function scoreTone(score) {
  if (score == null) return null;
  if (score > 7) return 'alto';
  if (score >= 4) return 'medio';
  return 'baixo';
}

/** Quem age pode avaliar ou registrar ocorrência sobre o alvo? Mesma regra do banco. */
function targetError(actor, target, self, above) {
  if (!target || !target.active) return DIRETORIA_ERRORS.member;
  if (target.discord_id === actor.discord_id) return self;
  if (actor.role !== CEO && roleLevel(target.role) >= roleLevel(actor.role)) return above;
  return null;
}

export const canTarget = (actor, target) => targetError(actor, target, 'x', 'x') === null;

/** Confere uma avaliação antes de gravar. Devolve { campo: mensagem } (vazio = ok). */
export function validateDirectorEvaluation(actor, target, input) {
  const errors = {};
  const t = targetError(actor, target, DIRETORIA_ERRORS.evalSelf, DIRETORIA_ERRORS.evalAbove);
  if (t) errors.avaliado_id = t;
  if (!input?.periodo_inicio || !input?.periodo_fim || input.periodo_fim < input.periodo_inicio) errors.periodo_fim = DIRETORIA_ERRORS.period;
  for (const f of SCORE_FIELDS) if (!validScore(input?.[f.key])) errors[f.key] = DIRETORIA_ERRORS.score;
  const comment = (input?.comentario ?? '').trim();
  if (comment.length > DIRETORIA_LIMITS.comment) errors.comentario = DIRETORIA_ERRORS.comment;
  else if (hasEmoji(comment)) errors.comentario = NO_EMOJI_MESSAGE;
  return errors;
}

export function validateOccurrence(actor, target, input) {
  const errors = {};
  const t = targetError(actor, target, DIRETORIA_ERRORS.occSelf, DIRETORIA_ERRORS.occAbove);
  if (t) errors.membro_id = t;
  if (!OCCURRENCE_TYPES.some((x) => x.code === input?.tipo)) errors.tipo = DIRETORIA_ERRORS.occType;
  const text = (input?.descricao ?? '').trim();
  if (!text || text.length > DIRETORIA_LIMITS.occurrence) errors.descricao = DIRETORIA_ERRORS.occText;
  else if (hasEmoji(text)) errors.descricao = NO_EMOJI_MESSAGE;
  return errors;
}

/** Campos da avaliação que o cliente envia (números e textos normalizados). */
export function pickDirectorEvaluation(input = {}) {
  const src = input && typeof input === 'object' ? input : {};
  const num = (v) => (v === '' || v == null ? null : Number(v));
  return {
    avaliado_id: String(src.avaliado_id ?? '').trim(),
    periodo_inicio: String(src.periodo_inicio ?? '').trim(),
    periodo_fim: String(src.periodo_fim ?? '').trim(),
    ...Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, num(src[f.key])])),
    comentario: String(src.comentario ?? '').trim(),
    visivel_avaliado: src.visivel_avaliado !== false,
    // Plano 11 (SQL 22): área opcional e "mostrar o comentário ao avaliado" (só vale se a avaliação é visível e tem comentário).
    area_id: String(src.area_id ?? '').trim() || null,
    comentario_visivel: src.comentario_visivel === true && src.visivel_avaliado !== false && Boolean(String(src.comentario ?? '').trim()),
  };
}

/* ---------------------------------------------------------------------------
 * Plano 11 · avaliações por área e no perfil (supabase/22_diretoria_avaliacoes_alinhamento.sql).
 * ------------------------------------------------------------------------- */

/** Mensagens das travas do SQL 22: IGUAIS às do banco (o teste do banco confere). */
export const AREA_EVAL_ERRORS = Object.freeze({
  area: 'Área não encontrada.',
  byAreaForbidden: 'Seu cargo não permite ver as avaliações por área.',
});

/**
 * Médias por área, como o banco calcula em diretoria_avaliacoes_por_area: a avaliação conta na área escolhida;
 * sem área escolhida, nas áreas atuais do avaliado; sem nenhuma, em "Sem área" (area_id null).
 * @param {object[]} evaluations avaliações da Diretoria (com area_id opcional)
 * @param {Array<{ id: string, nome: string, cor?: string, status?: string, ordem?: number }>} areas
 * @param {Array<{ area_id: string, discord_id: string }>} memberships
 */
export function averagesByArea(evaluations = [], areas = [], memberships = []) {
  const groups = new Map();
  const add = (areaId, e) => {
    const g = groups.get(areaId) ?? { ids: new Set(), rows: [] };
    g.ids.add(e.avaliado_id);
    g.rows.push(e);
    groups.set(areaId, g);
  };
  for (const e of evaluations) {
    if (e.area_id) { add(e.area_id, e); continue; }
    const mine = memberships.filter((m) => m.discord_id === e.avaliado_id);
    if (mine.length) mine.forEach((m) => add(m.area_id, e));
    else add(null, e);
  }
  const avg = (rows, key) => (rows.length ? Math.round((rows.reduce((n, r) => n + Number(r[key]), 0) / rows.length) * 10) / 10 : null);
  const line = (areaId, nome, extra, g) => ({
    area_id: areaId, area_nome: nome, ...extra, avaliados: g?.ids.size ?? 0, avaliacoes: g?.rows.length ?? 0,
    ...Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, g ? avg(g.rows, f.key) : null])),
  });
  const out = [...areas]
    .filter((a) => a.status === 'ativa' || groups.has(a.id))
    .sort((a, b) => (a.ordem ?? 0) - (b.ordem ?? 0) || a.nome.localeCompare(b.nome, 'pt-BR'))
    .map((a) => line(a.id, a.nome, { cor: a.cor ?? null, status: a.status ?? 'ativa' }, groups.get(a.id)));
  if (groups.has(null)) out.push(line(null, 'Sem área', { cor: null, status: null }, groups.get(null)));
  return out;
}

/** O que o avaliado vê no perfil: só as visíveis, sem quem avaliou; comentário só se o avaliador liberou. */
export function receivedEvaluationView(e, areaName = null) {
  return {
    periodo_inicio: e.periodo_inicio, periodo_fim: e.periodo_fim,
    ...Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, Number(e[f.key])])),
    comentario: e.comentario_visivel ? e.comentario ?? null : null,
    area_nome: areaName, criado_em: e.criado_em,
  };
}

/** Reunião criada na Agenda junto com o alinhamento: convoca o membro chamado e quem chamou. */
export function alignmentMeetingInput({ membroId, membroNome, selfId, mensagem, reuniaoEm, linkCall = '' }) {
  return {
    title: `Alinhamento com ${membroNome || membroId}`.slice(0, 150),
    description: String(mensagem ?? '').trim().slice(0, 2000) || null,
    starts_at: new Date(reuniaoEm).toISOString(),
    discord_link: String(linkCall ?? '').trim() || null,
    participants: [{ kind: 'member', value: String(membroId) }, ...(selfId && selfId !== membroId ? [{ kind: 'member', value: String(selfId) }] : [])],
  };
}

/** Médias de cada quesito numa lista de avaliações recebidas (uma casa), ou null sem avaliações. */
export function receivedAverages(list = []) {
  if (!list.length) return null;
  return Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, Math.round((list.reduce((n, e) => n + Number(e[f.key]), 0) / list.length) * 10) / 10]));
}

/** Motivo da troca de cargo: até 300 caracteres, sem emoji. Devolve a mensagem ou null. */
export function reasonError(text) {
  const t = String(text ?? '').trim();
  if (t.length > DIRETORIA_LIMITS.reason) return DIRETORIA_ERRORS.reason;
  return hasEmoji(t) ? NO_EMOJI_MESSAGE : null;
}

/** Regras de promoção: até 5000 caracteres, sem emoji. Devolve a mensagem ou null. */
export function promotionRulesError(text) {
  const t = String(text ?? '');
  if (t.length > DIRETORIA_LIMITS.rules) return DIRETORIA_ERRORS.rules;
  return hasEmoji(t) ? NO_EMOJI_MESSAGE : null;
}

/* ---------------------------------------------------------------------------
 * Produtividade (aba Produtividade): atividades reais já registradas no site,
 * contadas por semana pelo banco (diretoria_atividades). O peso de cada tipo fica aqui.
 * ------------------------------------------------------------------------- */
export const ACTIVITY_TYPES = Object.freeze([
  Object.freeze({ code: 'allowlist', label: 'Allowlists analisadas', weight: 1 }),
  Object.freeze({ code: 'entrevista', label: 'Entrevistas', weight: 2 }),
  Object.freeze({ code: 'procedimento', label: 'Procedimentos criados', weight: 3 }),
  Object.freeze({ code: 'reuniao', label: 'Reuniões criadas', weight: 1 }),
  Object.freeze({ code: 'area_entrada', label: 'Entradas em área', weight: 0 }),
  Object.freeze({ code: 'avaliacao_feita', label: 'Avaliações feitas', weight: 1 }),
  Object.freeze({ code: 'elogio', label: 'Elogios', weight: 2 }),
  Object.freeze({ code: 'advertencia', label: 'Advertências', weight: -1 }),
  Object.freeze({ code: 'suspensao', label: 'Suspensões', weight: -3 }),
  Object.freeze({ code: 'desligamento', label: 'Desligamentos', weight: 0 }),
]);
export const activityLabel = (code) => ACTIVITY_TYPES.find((t) => t.code === code)?.label ?? code;
const weightOf = (code) => ACTIVITY_TYPES.find((t) => t.code === code)?.weight ?? 0;

/**
 * Ranking: pontos = soma(peso x quantidade) por pessoa; score 0 a 10 em relação a quem
 * mais pontuou no período (o primeiro tem 10; pontos negativos ou zero, score 0).
 * @param {Array<{discord_id: string, tipo: string, total: number}>} rows
 * @returns {Array<{discord_id: string, pontos: number, score: number, porTipo: Record<string, number>}>}
 */
export function productivityRanking(rows) {
  const per = new Map();
  for (const r of rows ?? []) {
    const p = per.get(r.discord_id) ?? { discord_id: r.discord_id, pontos: 0, porTipo: {} };
    p.porTipo[r.tipo] = (p.porTipo[r.tipo] ?? 0) + r.total;
    p.pontos += weightOf(r.tipo) * r.total;
    per.set(r.discord_id, p);
  }
  const list = [...per.values()];
  const top = Math.max(0, ...list.map((p) => p.pontos));
  return list
    .map((p) => ({ ...p, score: top > 0 && p.pontos > 0 ? Math.round((p.pontos / top) * 100) / 10 : 0 }))
    .sort((a, b) => b.pontos - a.pontos || a.discord_id.localeCompare(b.discord_id));
}

/** Atividade total da staff por semana (as últimas `weeks` semanas, segunda-feira a segunda-feira). */
export function weeklyTotals(rows, weeks) {
  const map = new Map(weeks.map((w) => [w, 0]));
  for (const r of rows ?? []) if (map.has(r.semana)) map.set(r.semana, map.get(r.semana) + r.total);
  return weeks.map((w) => ({ semana: w, total: map.get(w) }));
}

/** Segunda-feira (AAAA-MM-DD, horário de Brasília) da semana de um instante. Mesma conta do banco. */
export function weekOf(iso) {
  const br = new Date(new Date(iso).getTime() - 3 * 3600_000);
  const day = (br.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate() - day)).toISOString().slice(0, 10);
}

/** Segunda-feira (AAAA-MM-DD, horário de Brasília) da semana de `date` e das N-1 anteriores. */
export function lastWeeks(n, now = new Date()) {
  const br = new Date(now.getTime() - 3 * 3600_000);
  const day = (br.getUTCDay() + 6) % 7; // 0 = segunda
  const monday = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate() - day);
  return Array.from({ length: n }, (_, i) => new Date(monday - (n - 1 - i) * 7 * 86400_000).toISOString().slice(0, 10));
}

/** CSV do ranking (separador ";" para abrir direto no Excel em português; aspas escapadas). */
export function rankingCsv(ranking, nameOf) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[";\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
  };
  const head = ['Posição', 'Membro', 'Discord ID', 'Pontos', 'Score', ...ACTIVITY_TYPES.map((t) => t.label)];
  const lines = ranking.map((r, i) => [i + 1, nameOf(r.discord_id), r.discord_id, r.pontos, r.score.toFixed(1),
    ...ACTIVITY_TYPES.map((t) => r.porTipo[t.code] ?? 0)]);
  return [head, ...lines].map((l) => l.map(cell).join(';')).join('\r\n');
}

/* ---------------------------------------------------------------------------
 * Indicadores (cards do topo). Calculados a partir das listas que a Diretoria já lê.
 * ------------------------------------------------------------------------- */
const monthStart = (d, offset = 0) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1, 3)); // 00:00 de Brasília

/** Variação percentual (null quando não há base de comparação). */
export function trend(current, previous) {
  if (!previous) return current ? null : 0;
  return Math.round(((current - previous) / previous) * 100);
}

export function dashboardKpis({ members = [], evaluations = [], occurrences = [], roleHistory = [], now = new Date() }) {
  const active = members.filter((m) => m.active);
  const thisMonth = monthStart(now);
  const lastMonth = monthStart(now, -1);
  const inRange = (iso, a, b) => { const t = new Date(iso).getTime(); return t >= a.getTime() && t < b.getTime(); };
  const next = monthStart(now, 1);
  const cutoff = now.getTime() - 30 * 86400_000;
  const evaluated = new Set(evaluations.filter((e) => new Date(e.criado_em).getTime() > cutoff).map((e) => e.avaliado_id));
  const promotions = (a, b) => roleHistory.filter((h) => inRange(h.feito_em, a, b) && roleLevel(h.cargo_novo) > roleLevel(h.cargo_anterior)).length;
  const occ = (a, b) => occurrences.filter((o) => inRange(o.feito_em, a, b)).length;
  const joined = (a, b) => members.filter((m) => inRange(m.created_at, a, b)).length;
  return {
    total: { value: active.length, novos: joined(thisMonth, next), trend: trend(joined(thisMonth, next), joined(lastMonth, thisMonth)) },
    semArea: { value: active.filter((m) => !(m.areas?.length)).length },
    pendentes: { value: active.filter((m) => !evaluated.has(m.discord_id)).length },
    ocorrencias: { value: occ(thisMonth, next), trend: trend(occ(thisMonth, next), occ(lastMonth, thisMonth)) },
    promocoes: { value: promotions(thisMonth, next), trend: trend(promotions(thisMonth, next), promotions(lastMonth, thisMonth)) },
  };
}

/** Membros ativos sem avaliação da Diretoria nos últimos 30 dias. */
export function pendingEvaluation(members, evaluations, now = new Date()) {
  const cutoff = now.getTime() - 30 * 86400_000;
  const done = new Set(evaluations.filter((e) => new Date(e.criado_em).getTime() > cutoff).map((e) => e.avaliado_id));
  return members.filter((m) => m.active && !done.has(m.discord_id));
}

/** Média das notas por cargo do avaliado (para o gráfico radar). */
export function averagesByRole(evaluations, roleOf) {
  const per = new Map();
  for (const e of evaluations) {
    const role = roleOf(e.avaliado_id);
    if (!role) continue;
    const acc = per.get(role) ?? { role, n: 0, sums: Object.fromEntries(SCORE_FIELDS.map((f) => [f.key, 0])) };
    acc.n += 1;
    for (const f of SCORE_FIELDS) acc.sums[f.key] += Number(e[f.key]) || 0;
    per.set(role, acc);
  }
  return [...per.values()]
    .sort((a, b) => roleLevel(a.role) - roleLevel(b.role))
    .map((a) => ({ role: a.role, n: a.n, values: SCORE_FIELDS.map((f) => Math.round((a.sums[f.key] / a.n) * 10) / 10) }));
}

/** Quantas avaliações em cada faixa de nota geral (0-2, 2-4, 4-6, 6-8, 8-10). */
export function scoreDistribution(evaluations) {
  const bins = [0, 0, 0, 0, 0];
  for (const e of evaluations) bins[Math.min(4, Math.floor(Number(e.nota_geral) / 2))] += 1;
  return bins;
}

/** Tempo médio (em dias) que as pessoas ficaram em cada cargo antes de subir. */
export function averageDaysBeforePromotion(roleHistory, members) {
  const byMember = new Map();
  for (const h of [...roleHistory].sort((a, b) => a.feito_em.localeCompare(b.feito_em))) {
    if (!byMember.has(h.membro_id)) byMember.set(h.membro_id, []);
    byMember.get(h.membro_id).push(h);
  }
  const sums = new Map();
  for (const [id, list] of byMember) {
    let since = members.find((m) => m.discord_id === id)?.created_at ?? null;
    for (const h of list) {
      if (since && roleLevel(h.cargo_novo) > roleLevel(h.cargo_anterior)) {
        const days = (new Date(h.feito_em) - new Date(since)) / 86400_000;
        if (days >= 0) {
          const s = sums.get(h.cargo_anterior) ?? { total: 0, n: 0 };
          s.total += days; s.n += 1;
          sums.set(h.cargo_anterior, s);
        }
      }
      since = h.feito_em;
    }
  }
  return Object.fromEntries([...sums].map(([role, s]) => [role, Math.round(s.total / s.n)]));
}
