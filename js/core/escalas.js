// Escala e registro das entrevistas de allowlist (documento 13): funções puras. A tela, o mock, a Edge Function
// (enviar-discord, que embute este arquivo) e o banco (supabase/24_escalas.sql) usam as mesmas regras.
// Mensagens das travas IGUAIS às do SQL (tests/db/banco.test.mjs confere). Horário sempre de Brasília (UTC-3).
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';

/** Domingo = 0 ... Sábado = 6 (igual a extract(dow) do Postgres). */
export const ESC_WEEKDAYS = Object.freeze(['Domingo', 'Segunda-Feira', 'Terça-Feira', 'Quarta-Feira', 'Quinta-Feira', 'Sexta-Feira', 'Sábado']);
export const ESC_WEEKDAYS_SHORT = Object.freeze(['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']);
/** Ordem de exibição: segunda a domingo (como na escala do Discord). */
export const ESC_DAY_ORDER = Object.freeze([1, 2, 3, 4, 5, 6, 0]);

export const ESC_STATUS_LABELS = Object.freeze({
  aberta_disponibilidade: 'Aberta para disponibilidade', analise: 'Em análise', publicada: 'Publicada', encerrada: 'Encerrada',
});
export const ESC_SESSION_STATUS_LABELS = Object.freeze({
  agendada: 'Agendada', em_andamento: 'Em andamento', concluida: 'Concluída', cancelada: 'Cancelada',
  registro_pendente: 'Registro pendente', registro_concluido: 'Registro concluído',
});
export const ESC_ROLE_LABELS = Object.freeze({ entrevistador: 'Entrevistador', suporte: 'Suporte', acompanhante: 'Acompanhante' });
export const ESC_SLOT_ROLES = Object.freeze(['entrevistador', 'suporte']);
export const ESC_PARTICIPANT_ROLES = Object.freeze(['entrevistador', 'suporte', 'acompanhante']);

export const ESC_LIMITS = Object.freeze({ periodDays: 62, notes: 2000, reason: 300, total: 500, participants: 40, printBytes: 8 * 1024 * 1024, antecedencia: 180 });
export const ESC_PRINT_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/webp']);
/** Mínimo de pessoas disponíveis para a célula ficar verde (1 a 2 = amarelo, 0 = vermelho). */
export const ESC_ENOUGH = 3;

export const DEFAULT_ESCALA_CONFIG = Object.freeze({
  dias_semana: Object.freeze([2, 4, 6, 0]),
  horarios: Object.freeze(['10:00', '15:00', '20:00', '00:00']),
  antecedencia_aviso_minutos: 10,
  canal_discord_escala: '', canal_discord_registros: '', canal_discord_avisos: '',
  cargo_discord_entrevistador: '', cargo_discord_suporte: '',
  mensagem_link_call: 'https://discord.com/channels/1419521423587938317/1419521433008209987',
  mensagem_cargo_id: '1419521423990456324',
});

/** Iguais às de supabase/24_escalas.sql (tests/db/banco.test.mjs confere). */
export const ESCALA_ERRORS = Object.freeze({
  period: 'O período deve ter o fim igual ou depois do início e no máximo 62 dias.',
  deadline: 'O prazo para informar disponibilidade precisa estar no futuro.',
  active: 'Já existe uma escala em andamento. Encerre a atual antes de abrir outra.',
  notOpen: 'A escala não está aberta para disponibilidade.',
  closed: 'O prazo para informar disponibilidade já terminou.',
  notAnalysis: 'A escala não está em análise.',
  notPublished: 'A escala não está publicada.',
  empty: 'Defina pelo menos um horário na escala antes de publicar.',
  notEligible: 'Esta pessoa não faz parte da equipe de entrevistas ou está inativa.',
  alreadyThere: 'Esta pessoa já está neste horário.',
  list: 'Lista de horários inválida.',
  noSession: 'Sessão não encontrada.',
  notParticipant: 'Só quem está na sessão ou a Direção pode fazer isso.',
  registered: 'Esta sessão já possui um registro.',
  registeredLocked: 'Esta sessão já tem registro. Só a Direção altera depois disso.',
  total: 'Informe o total de entrevistados (0 a 500).',
  notes: 'As observações devem ter até 2000 caracteres e sem emojis.',
  reason: 'O motivo deve ter até 300 caracteres e sem emojis.',
  print: 'Envie o print da call.',
  interviewer: 'Marque pelo menos um entrevistador presente.',
  notDirection: 'Só a Direção edita um registro existente.',
  leaving: 'Quem sai precisa estar escalado nesta sessão.',
  absent: 'Quem falta precisa estar escalado e presente nesta sessão.',
  startOnly: 'Só uma sessão agendada pode ser iniciada.',
  alreadyClosed: 'Esta sessão já foi encerrada.',
  badStatus: 'Estado inválido.',
  noRegistro: 'Registro não encontrado.',
  noSlot: 'Horário da escala não encontrado.',
  noEscala: 'Escala não encontrada.',
  immutable: 'O histórico das escalas não pode ser alterado nem apagado.',
});

export const ESCALA_FIELD_ERRORS = Object.freeze({
  required: 'Campo obrigatório.',
  days: 'Marque pelo menos um dia da semana.',
  times: 'Informe de 1 a 12 horários no formato HH:MM (24 horas), sem repetir.',
  notice: 'Informe um número de minutos de 0 a 180.',
  channelId: 'ID do canal: só números, de 17 a 20 dígitos.',
  roleId: 'ID do cargo: só números, de 17 a 20 dígitos.',
  link: 'O link deve começar com https://discord.com/channels/.',
  date: 'Informe uma data válida.',
  printType: 'O print deve ser PNG, JPG ou WEBP.',
  printSize: 'O print pode ter até 8 MB.',
});

/** Texto simples de cada tipo de ação do histórico (escalas_historico.tipo). */
export const ESC_HISTORY_LABELS = Object.freeze({
  escala_aberta: 'Escala aberta', disponibilidade_encerrada: 'Disponibilidade encerrada', escala_publicada: 'Escala publicada',
  escala_encerrada: 'Escala encerrada', escala_discord_enviada: 'Escala enviada ao Discord', escala_discord_falhou: 'Falha ao enviar a escala ao Discord',
  slot_realocado: 'Horário realocado', substituicao_registrada: 'Substituição registrada', ausencia_registrada: 'Ausência registrada',
  sessao_em_andamento: 'Sessão iniciada', sessao_cancelada: 'Sessão cancelada', registro_criado: 'Registro criado', registro_editado: 'Registro editado',
  registro_discord_enviado: 'Registro enviado ao Discord', aviso_enviado: 'Aviso enviado', aviso_falhou: 'Falha no aviso',
  cancelamento_avisado: 'Cancelamento avisado no privado', agenda_limpa: 'Agenda das entrevistas limpa',
});

const escClean = (v) => String(v ?? '').trim();
const ESC_DISCORD_ID = /^[0-9]{17,20}$/;
const ESC_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ESC_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ESC_CALL_LINK = /^https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+$/;

/* ---------------------------------------------------------------------------
 * Horários e datas
 * ------------------------------------------------------------------------- */
/** "10:00" → "10h"; "20:30" → "20h30". */
export const horarioLabel = (horario) => {
  const [h, m] = String(horario ?? '').split(':');
  return m && m !== '00' ? `${h}h${m}` : `${h}h`;
};
/** Ordem do dia de entrevistas: 00:00 vem por último (a noite vira o dia seguinte, como na escala do Discord). */
export const horarioSortKey = (horario) => (String(horario).startsWith('00:') ? `24${String(horario).slice(2)}` : String(horario));
export const sortHorarios = (list) => [...list].sort((a, b) => horarioSortKey(a).localeCompare(horarioSortKey(b)));
export const sortDays = (days) => ESC_DAY_ORDER.filter((d) => days.includes(d));

/** Início da sessão: data (AAAA-MM-DD) e horário (HH:MM) de Brasília. Igual a kb_esc_inicio do SQL. */
export const sessionStart = (data, horario) => new Date(`${data}T${horario}:00-03:00`);

/** Hoje em Brasília, AAAA-MM-DD (nunca o dia em UTC: depois das 21h ele já é o seguinte). */
export const brasiliaToday = (now = new Date()) => new Date(new Date(now).getTime() - 3 * 3_600_000).toISOString().slice(0, 10);

/** Dia da semana (0 a 6) de uma data AAAA-MM-DD. */
export const weekdayOf = (data) => new Date(`${data}T12:00:00Z`).getUTCDay();

/** "18/10/2026" para uma data AAAA-MM-DD. */
export const formatDateBr = (data) => (ESC_DATE.test(String(data)) ? String(data).split('-').reverse().join('/') : '');

/** Datas AAAA-MM-DD de um período que caem nos dias da semana dados. */
export function datesInPeriod(inicio, fim, dias) {
  const out = [];
  if (!ESC_DATE.test(inicio) || !ESC_DATE.test(fim)) return out;
  for (let t = Date.parse(`${inicio}T12:00:00Z`); t <= Date.parse(`${fim}T12:00:00Z`) && out.length < 400; t += 86_400_000) {
    const d = new Date(t);
    if (dias.includes(d.getUTCDay())) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * Validações (mesmas no site, no mock e no supabase-adapter; o banco repete as essenciais)
 * ------------------------------------------------------------------------- */
const escResult = (errors) => ({ valid: Object.keys(errors).length === 0, errors });

/** @param {Partial<typeof DEFAULT_ESCALA_CONFIG>} c */
export function validateEscalaConfig(c = {}) {
  const errors = {};
  const days = Array.isArray(c.dias_semana) ? c.dias_semana : [];
  if (!days.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size !== days.length) errors.dias_semana = ESCALA_FIELD_ERRORS.days;
  const times = Array.isArray(c.horarios) ? c.horarios : [];
  if (!times.length || times.length > 12 || times.some((t) => !ESC_TIME.test(t)) || new Set(times).size !== times.length) errors.horarios = ESCALA_FIELD_ERRORS.times;
  const n = Number(c.antecedencia_aviso_minutos);
  if (!Number.isInteger(n) || n < 0 || n > ESC_LIMITS.antecedencia) errors.antecedencia_aviso_minutos = ESCALA_FIELD_ERRORS.notice;
  for (const f of ['canal_discord_escala', 'canal_discord_registros', 'canal_discord_avisos']) {
    if (escClean(c[f]) && !ESC_DISCORD_ID.test(escClean(c[f]))) errors[f] = ESCALA_FIELD_ERRORS.channelId;
  }
  for (const f of ['cargo_discord_entrevistador', 'cargo_discord_suporte', 'mensagem_cargo_id']) {
    if (escClean(c[f]) && !ESC_DISCORD_ID.test(escClean(c[f]))) errors[f] = ESCALA_FIELD_ERRORS.roleId;
  }
  if (!escClean(c.mensagem_cargo_id)) errors.mensagem_cargo_id = ESCALA_FIELD_ERRORS.required;
  if (!ESC_CALL_LINK.test(escClean(c.mensagem_link_call))) errors.mensagem_link_call = ESCALA_FIELD_ERRORS.link;
  return escResult(errors);
}

/** Configuração vinda do cliente: só os campos editáveis, textos aparados, listas ordenadas. */
export function pickEscalaConfig(c = {}) {
  const src = c && typeof c === 'object' ? c : {};
  const out = {};
  if ('dias_semana' in src) out.dias_semana = Array.isArray(src.dias_semana) ? [...new Set(src.dias_semana.map(Number))].sort((a, b) => a - b) : src.dias_semana;
  if ('horarios' in src) out.horarios = Array.isArray(src.horarios) ? sortHorarios([...new Set(src.horarios.map(escClean))]) : src.horarios;
  if ('antecedencia_aviso_minutos' in src) out.antecedencia_aviso_minutos = Number(src.antecedencia_aviso_minutos);
  for (const f of ['canal_discord_escala', 'canal_discord_registros', 'canal_discord_avisos', 'cargo_discord_entrevistador', 'cargo_discord_suporte', 'mensagem_link_call', 'mensagem_cargo_id']) {
    if (f in src) out[f] = escClean(src[f]);
  }
  return out;
}

/** Abrir escala: { periodo_inicio, periodo_fim (AAAA-MM-DD), encerramento (data/hora ISO) }. */
export function validateOpenEscala(e = {}, now = new Date()) {
  const errors = {};
  if (!ESC_DATE.test(escClean(e.periodo_inicio))) errors.periodo_inicio = ESCALA_FIELD_ERRORS.date;
  if (!ESC_DATE.test(escClean(e.periodo_fim))) errors.periodo_fim = ESCALA_FIELD_ERRORS.date;
  if (!errors.periodo_inicio && !errors.periodo_fim) {
    const days = (Date.parse(`${e.periodo_fim}T12:00:00Z`) - Date.parse(`${e.periodo_inicio}T12:00:00Z`)) / 86_400_000;
    if (!(days >= 0 && days <= ESC_LIMITS.periodDays)) errors.periodo_fim = ESCALA_ERRORS.period;
  }
  if (!e.encerramento || Number.isNaN(Date.parse(e.encerramento))) errors.encerramento = ESCALA_FIELD_ERRORS.date;
  else if (Date.parse(e.encerramento) <= new Date(now).getTime()) errors.encerramento = ESCALA_ERRORS.deadline;
  return escResult(errors);
}

/** Disponibilidade: [{ dia_semana, horario }] dentro dos dias e horários da configuração. */
export function validateAvailability(slots, config = DEFAULT_ESCALA_CONFIG) {
  if (!Array.isArray(slots) || slots.length > 100) return escResult({ _: ESCALA_ERRORS.list });
  const ok = slots.every((s) => s && Number.isInteger(s.dia_semana) && config.dias_semana.includes(s.dia_semana) && config.horarios.includes(s.horario));
  return ok ? escResult({}) : escResult({ _: ESCALA_ERRORS.list });
}

/** Escala definida pela Direção: [{ dia_semana, horario, discord_id, funcao }]. */
export function validateSlots(slots) {
  if (!Array.isArray(slots) || slots.length > 500) return escResult({ _: ESCALA_ERRORS.list });
  const ok = slots.every((s) => s && Number.isInteger(s.dia_semana) && s.dia_semana >= 0 && s.dia_semana <= 6
    && ESC_TIME.test(s.horario) && ESC_DISCORD_ID.test(String(s.discord_id)) && ESC_SLOT_ROLES.includes(s.funcao));
  return ok ? escResult({}) : escResult({ _: ESCALA_ERRORS.list });
}

/**
 * Registro da sessão. `participantes`: lista final [{ discord_id, funcao, presente, substituindo_id? }].
 * @param {{ total_entrevistados?: number|string, observacoes?: string, tem_print?: boolean, participantes?: object[] }} r
 */
export function validateRegistro(r = {}) {
  const errors = {};
  const total = typeof r.total_entrevistados === 'string' && r.total_entrevistados.trim() === '' ? NaN : Number(r.total_entrevistados);
  if (!Number.isInteger(total) || total < 0 || total > ESC_LIMITS.total) errors.total_entrevistados = ESCALA_ERRORS.total;
  const notes = escClean(r.observacoes);
  if (notes.length > ESC_LIMITS.notes) errors.observacoes = ESCALA_ERRORS.notes;
  else if (hasEmoji(notes)) errors.observacoes = NO_EMOJI_MESSAGE;
  if (!r.tem_print) errors.print = ESCALA_ERRORS.print;
  const list = Array.isArray(r.participantes) ? r.participantes : [];
  if (list.length > ESC_LIMITS.participants || list.some((p) => !p || !ESC_DISCORD_ID.test(String(p.discord_id)) || !ESC_PARTICIPANT_ROLES.includes(p.funcao))) {
    errors.participantes = ESCALA_ERRORS.list;
  } else if (!list.some((p) => p.presente !== false && p.funcao === 'entrevistador')) errors.participantes = ESCALA_ERRORS.interviewer;
  return escResult(errors);
}

/** Observações na edição do registro (sem exigir print nem participantes). */
export function validateRegistroEdit(r = {}) {
  const base = validateRegistro({ ...r, tem_print: true, participantes: [{ discord_id: '100000000000000000', funcao: 'entrevistador', presente: true }] });
  return escResult(Object.fromEntries(Object.entries(base.errors).filter(([k]) => k === 'total_entrevistados' || k === 'observacoes')));
}

export function validateSubstitution({ original, substituto, motivo } = {}) {
  const errors = {};
  if (!ESC_DISCORD_ID.test(escClean(original))) errors.original = ESCALA_FIELD_ERRORS.required;
  if (!ESC_DISCORD_ID.test(escClean(substituto))) errors.substituto = ESCALA_FIELD_ERRORS.required;
  else if (escClean(original) === escClean(substituto)) errors.substituto = ESCALA_ERRORS.alreadyThere;
  const why = escClean(motivo);
  if (why.length > ESC_LIMITS.reason) errors.motivo = ESCALA_ERRORS.reason;
  else if (hasEmoji(why)) errors.motivo = NO_EMOJI_MESSAGE;
  return escResult(errors);
}

/** @param {{ type?: string, size?: number }} file */
export function validatePrintFile(file) {
  if (!file || !ESC_PRINT_TYPES.includes(file.type)) return { valid: false, error: ESCALA_FIELD_ERRORS.printType };
  if (!(file.size > 0) || file.size > ESC_LIMITS.printBytes) return { valid: false, error: ESCALA_FIELD_ERRORS.printSize };
  return { valid: true, error: '' };
}

/* ---------------------------------------------------------------------------
 * Grade de disponibilidade e escala
 * ------------------------------------------------------------------------- */
/** 'nenhum' (vermelho), 'poucos' (amarelo) ou 'suficiente' (verde). */
export const cellLevel = (count) => (count <= 0 ? 'nenhum' : count < ESC_ENOUGH ? 'poucos' : 'suficiente');
export const CELL_LEVEL_LABELS = Object.freeze({ nenhum: 'Ninguém disponível', poucos: 'Poucos disponíveis', suficiente: 'Disponíveis o suficiente' });

export const cellKey = (dia, horario) => `${dia}|${horario}`;

/** Agrupa os horários da escala por célula: Map("dia|horario" → [{ discord_id, funcao, id? }]). */
export function slotsByCell(slots = []) {
  const map = new Map();
  for (const s of slots) {
    const key = cellKey(s.dia_semana, s.horario);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return map;
}

/** Ponto de partida para a análise: todos os disponíveis de cada célula entram como entrevistador. */
export const suggestSlots = (celulas = []) => celulas.flatMap((c) => (c.discord_ids ?? []).map((id) => ({
  dia_semana: c.dia_semana, horario: c.horario, discord_id: id, funcao: 'entrevistador',
})));

/** Resumo para a confirmação de "Definir escala": quantos horários, pessoas e células sem ninguém. */
export function slotsSummary(slots = [], config = DEFAULT_ESCALA_CONFIG) {
  const cells = slotsByCell(slots);
  const people = new Set(slots.map((s) => s.discord_id));
  const empty = [];
  for (const dia of sortDays(config.dias_semana)) for (const h of sortHorarios(config.horarios)) if (!cells.has(cellKey(dia, h))) empty.push({ dia_semana: dia, horario: h });
  return { cells: cells.size, slots: slots.length, people: people.size, empty };
}

/* ---------------------------------------------------------------------------
 * Sessões
 * ------------------------------------------------------------------------- */
/** Janela depois do horário em que ainda se avisa (aviso atrasado por falha do agendador). */
export const NOTICE_GRACE_MIN = 30;
/** Depois de quanto tempo do início uma sessão sem registro vira "registro pendente". */
export const REGISTRO_PENDENTE_MIN = 60;

/** Estado mostrado na agenda: junta o status da sessão com a existência do registro. */
export function sessionView(session, now = new Date()) {
  if (session.status === 'cancelada') return 'cancelada';
  if (session.tem_registro) return 'registro_concluido';
  if (session.status === 'concluida') return 'concluida';
  const late = new Date(now).getTime() - sessionStart(session.data_entrevista, session.horario).getTime() > REGISTRO_PENDENTE_MIN * 60_000;
  if (late) return 'registro_pendente';
  return session.status;
}

/** Sessões que precisam de aviso agora: não avisadas, no horário de avisar e ainda dentro da janela. */
export function sessionsDueForNotice(sessions = [], config = DEFAULT_ESCALA_CONFIG, now = new Date()) {
  const t = new Date(now).getTime();
  return sessions.filter((s) => {
    if (s.aviso_enviado || !['agendada', 'em_andamento'].includes(s.status)) return false;
    const start = sessionStart(s.data_entrevista, s.horario).getTime();
    return start - config.antecedencia_aviso_minutos * 60_000 <= t && start > t - NOTICE_GRACE_MIN * 60_000;
  });
}

/** Participantes presentes por função (entrevistadores, suportes e acompanhantes). */
export function groupParticipants(list = []) {
  const out = { entrevistador: [], suporte: [], acompanhante: [], ausentes: [] };
  for (const p of list) (p.presente === false ? out.ausentes : out[p.funcao] ?? out.acompanhante).push(p);
  return out;
}

/** Quem pode registrar, copiar a mensagem e mexer na sessão: participante presente ou Direção. */
export const isSessionParticipant = (session, discordId) => (session.participantes ?? []).some((p) => p.discord_id === discordId && p.presente !== false);

/** Aviso de privado e do canal vai para quem está presente (ausentes não). */
export const noticeRecipients = (participants = []) => participants.filter((p) => p.presente !== false && ESC_DISCORD_ID.test(String(p.discord_id)));

/* ---------------------------------------------------------------------------
 * Mensagem para copiar no chat de entrevistas (Fase 4.3)
 * ------------------------------------------------------------------------- */
export function interviewMessage(horario, config = DEFAULT_ESCALA_CONFIG) {
  const h = horarioLabel(horario);
  const link = ESC_CALL_LINK.test(escClean(config.mensagem_link_call)) ? escClean(config.mensagem_link_call) : DEFAULT_ESCALA_CONFIG.mensagem_link_call;
  const role = ESC_DISCORD_ID.test(escClean(config.mensagem_cargo_id)) ? escClean(config.mensagem_cargo_id) : DEFAULT_ESCALA_CONFIG.mensagem_cargo_id;
  return [
    `# ENTREVISTA ${h}`,
    '',
    `### A call será aberta às **${h}** e ficará disponível por **10 minutos**. Após esse período, ela será fechada.`,
    '',
    `[Cliquem Aqui](${link})`,
    '',
    'Fiquem atentos!',
    `<@&${role}>`,
  ].join('\n');
}

/* ---------------------------------------------------------------------------
 * Discord · escala publicada, aviso e registro
 * ------------------------------------------------------------------------- */
export const ESC_DISCORD = Object.freeze({
  title: 'Escala de Horários | Entrevistas',
  noticeColor: 0xE0A43A,
  registroColor: 0x3DAA6A,
});
export const ESC_DISCORD_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite esta ação das entrevistas.',
  notFound: 'Escala ou sessão não encontrada.',
  notPublished: 'Só uma escala publicada vai para o Discord.',
  noChannel: 'Cadastre o ID do canal do Discord em Entrevistas › Configurações.',
  noBot: 'O envio pelo bot não está ligado. Peça à administração para guardar o token no Supabase (segredo DISCORD_BOT_TOKEN).',
  noRegistro: 'Esta sessão ainda não tem registro.',
  notCancelled: 'A sessão não está cancelada.',
  noPrint: 'O print da call não foi encontrado.',
  cron: 'Segredo do agendador inválido.',
  channel: (status) => `O Discord recusou o envio no canal (HTTP ${status}). Confira o ID do canal e se o bot pode enviar mensagens nele.`,
  outdatedFunction: 'A função enviar-discord instalada no Supabase é de uma versão antiga e ainda não envia a escala nem os registros das entrevistas. Avise a administração para colar o arquivo novo (supabase/functions/enviar-discord/index.ts) e clicar Deploy.',
});

const escMention = (id) => `<@${id}>`;
const roleMarker = (roleId, fallback) => (ESC_DISCORD_ID.test(escClean(roleId)) ? `<@&${escClean(roleId)}>` : `**${fallback}**`);

/** Linha de um horário: "• 10h — @all <@a> <@b> @sup <@c>". */
export function escalaLine(horario, cell = [], config = DEFAULT_ESCALA_CONFIG) {
  const who = (funcao) => cell.filter((s) => s.funcao === funcao).map((s) => escMention(s.discord_id));
  const parts = [];
  const all = who('entrevistador');
  const sup = who('suporte');
  if (all.length) parts.push(`${roleMarker(config.cargo_discord_entrevistador, '@all')} ${all.join(' ')}`);
  if (sup.length) parts.push(`${roleMarker(config.cargo_discord_suporte, '@sup')} ${sup.join(' ')}`);
  return `• ${horarioLabel(horario)} — ${parts.length ? parts.join(' ') : '*sem escalados*'}`;
}

/**
 * Mensagens da escala publicada: uma por dia da semana (o Discord limita o texto a 2000 caracteres). A primeira leva o título.
 * Marca as pessoas (ping) e mostra os cargos sem marcar ninguém.
 */
export function buildEscalaMessages(escala, slots = [], config = DEFAULT_ESCALA_CONFIG) {
  const cells = slotsByCell(slots);
  const days = sortDays([...new Set(slots.map((s) => s.dia_semana))]);
  const header = `# ${ESC_DISCORD.title}\n*Período: ${formatDateBr(escala.periodo_inicio)} a ${formatDateBr(escala.periodo_fim)}*`;
  const blocks = days.map((dia) => {
    const lines = sortHorarios([...new Set(slots.filter((s) => s.dia_semana === dia).map((s) => s.horario))])
      .map((h) => escalaLine(h, cells.get(cellKey(dia, h)), config));
    return `## ${ESC_WEEKDAYS[dia]}\n${lines.join('\n')}`.slice(0, 1900);
  });
  if (!blocks.length) blocks.push('*Nenhum horário definido.*');
  return blocks.map((block, i) => ({
    content: (i === 0 ? `${header}\n\n${block}` : block).slice(0, 2000),
    allowed_mentions: { parse: [], users: [...new Set(slots.map((s) => s.discord_id))].filter((id) => ESC_DISCORD_ID.test(id)).slice(0, 100) },
  }));
}

/** Aviso no canal de avisos: marca quem está escalado na sessão. */
export function buildSessionNoticeChannel(session, participants = [], { antecedencia = 10 } = {}) {
  const people = noticeRecipients(participants);
  const ts = Math.floor(sessionStart(session.data_entrevista, session.horario).getTime() / 1000);
  const line = (funcao) => people.filter((p) => p.funcao === funcao).map((p) => escMention(p.discord_id)).join(' ');
  const rows = ESC_PARTICIPANT_ROLES.map((f) => (line(f) ? `**${ESC_ROLE_LABELS[f]}:** ${line(f)}` : '')).filter(Boolean);
  return {
    content: [`**Entrevista às ${horarioLabel(session.horario)}** começa <t:${ts}:R> (aviso ${antecedencia} min antes).`, ...rows].join('\n').slice(0, 2000),
    allowed_mentions: { parse: [], users: people.map((p) => p.discord_id).slice(0, 100) },
  };
}

/** Aviso no privado de cada escalado. */
export function buildSessionNoticeDm(session, participant, { siteUrl = '', now = new Date() } = {}) {
  const ts = Math.floor(sessionStart(session.data_entrevista, session.horario).getTime() / 1000);
  const site = escClean(siteUrl);
  return {
    content: 'Lembrete: você está escalado(a) para uma entrevista de allowlist.',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Entrevista às ${horarioLabel(session.horario)}`,
      ...(/^https:\/\/[^\s#?]{1,300}$/.test(site) ? { url: `${site}#/entrevistas` } : {}),
      color: ESC_DISCORD.noticeColor,
      fields: [
        { name: '◷ Quando', value: `${formatDateBr(session.data_entrevista)} às ${session.horario} (Brasília) · <t:${ts}:R>`, inline: false },
        { name: '✎ Sua função', value: ESC_ROLE_LABELS[participant.funcao] ?? participant.funcao, inline: true },
      ],
      timestamp: new Date(now).toISOString(),
      footer: { text: 'Bloodlines RP · Entrevistas' },
    }],
  };
}

/**
 * Documento 14 · privado avisando que a sessão foi cancelada (para os outros escalados). `motivo` é opcional.
 * @param {{ data_entrevista: string, horario: string }} session
 * @param {{ funcao: string }} participant
 */
export function buildSessionCancelDm(session, participant, { motivo = '', cancelledBy = '', now = new Date() } = {}) {
  const why = escClean(motivo);
  return {
    content: 'Aviso: uma sessão de entrevista em que você estava escalado(a) foi cancelada.',
    allowed_mentions: { parse: [] },
    embeds: [{
      title: `Entrevista das ${horarioLabel(session.horario)} cancelada`,
      color: ESC_DISCORD.noticeColor,
      fields: [
        { name: '◷ Era em', value: `${formatDateBr(session.data_entrevista)} às ${session.horario} (Brasília)`, inline: false },
        { name: '✎ Sua função', value: ESC_ROLE_LABELS[participant.funcao] ?? participant.funcao, inline: true },
        ...(escClean(cancelledBy) ? [{ name: '● Cancelada por', value: escClean(cancelledBy).slice(0, 80), inline: true }] : []),
        ...(why ? [{ name: '↳ Motivo', value: why.slice(0, 300), inline: false }] : []),
      ],
      timestamp: new Date(now).toISOString(),
      footer: { text: 'Bloodlines RP · Entrevistas' },
    }],
  };
}

/**
 * Registro da sessão no canal de registros (embed com a imagem anexada). `printName` = nome do arquivo anexado.
 * @param {{ registro: object, participants: object[], names?: Map<string,string>, printName?: string, registeredBy?: string }} o
 */
export function buildRegistroMessage(session, { registro, participants = [], printName = '', registeredBy = '' } = {}) {
  const group = groupParticipants(participants);
  const list = (arr) => (arr.length ? arr.map((p) => escMention(p.discord_id)).join(' ') : '–');
  const swaps = participants.filter((p) => p.substituindo_id && p.presente !== false)
    .map((p) => `${escMention(p.discord_id)} no lugar de ${escMention(p.substituindo_id)}`);
  const fields = [
    { name: '◷ Data', value: formatDateBr(session.data_entrevista), inline: true },
    { name: '◷ Horário', value: session.horario, inline: true },
    { name: '◈ Entrevistados', value: String(registro.total_entrevistados), inline: true },
    { name: '✎ Entrevistadores', value: list(group.entrevistador).slice(0, 1000), inline: false },
    { name: '⏣ Suportes e acompanhantes', value: list([...group.suporte, ...group.acompanhante]).slice(0, 1000), inline: false },
  ];
  if (swaps.length) fields.push({ name: '↳ Substituições', value: swaps.join('\n').slice(0, 1000), inline: false });
  if (group.ausentes.length) fields.push({ name: '✗ Ausentes', value: list(group.ausentes).slice(0, 1000), inline: false });
  if (escClean(registro.observacoes)) fields.push({ name: '✎ Observações', value: escClean(registro.observacoes).slice(0, 1000), inline: false });
  if (escClean(registeredBy)) fields.push({ name: '✓ Registrado por', value: escClean(registeredBy).slice(0, 200), inline: true });
  return {
    allowed_mentions: { parse: [] },
    embeds: [{
      title: 'Registro de Entrevistas',
      color: ESC_DISCORD.registroColor,
      fields,
      ...(printName ? { image: { url: `attachment://${printName}` } } : {}),
      timestamp: new Date().toISOString(),
      footer: { text: 'Bloodlines RP · Entrevistas' },
    }],
    files: printName ? [printName] : [],
  };
}
