// Documento 14 · apagar, remover, cancelar e redefinir com auditoria (SQL 25).
// Regras puras usadas pelo mock, pelo supabase-adapter e pelas telas. Quem garante de verdade é o banco
// (funções do 25 conferem a permissão e gravam em audit_log); as mensagens abaixo são IGUAIS às do SQL
// (tests/db/banco.test.mjs confere).
import { NO_EMOJI_MESSAGE, hasEmoji } from './workflow.js';

/** Palavra que a pessoa digita para liberar o botão das ações de alto impacto. */
export const CONFIRM_WORD = 'CONFIRMAR';
export const REASON_MAX = 300;

export const APAGAR_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não permite esta ação.',
  notInstalled: 'Esta ação ainda não foi instalada no banco de dados (falta rodar o SQL 25).',
  reasonLength: `O motivo pode ter até ${REASON_MAX} caracteres.`,
  noEmoji: NO_EMOJI_MESSAGE,
  character: 'Personagem não encontrado.',
  session: 'Sessão não encontrada.',
  sessionClosed: 'Esta sessão já foi encerrada.',
  escala: 'Escala não encontrada.',
  escalaClosed: 'Esta escala já foi encerrada.',
  evaluation: 'Avaliação não encontrada.',
  evaluationDraft: 'Rascunho só o próprio autor apaga.',
  occurrence: 'Ocorrência não encontrada.',
  alignment: 'Alinhamento não encontrado.',
  alignmentCancelled: 'Este alinhamento já foi cancelado.',
  alignmentHappened: 'Este alinhamento já aconteceu e não pode ser cancelado.',
  question: 'Pergunta não encontrada.',
  item: 'Item não encontrado.',
});

/** Entidades e o que cada ação grava na auditoria (entity / action de audit_log), para a tela de Auditoria. */
export const APAGAR_AUDIT_LABELS = Object.freeze({
  'sessao_entrevista:cancelada': 'Sessão de entrevista cancelada',
  'escala:fechada': 'Escala fechada',
  'configuracao_entrevistas:alterada': 'Configurações das entrevistas alteradas',
  'configuracao_entrevistas:redefinida': 'Configurações das entrevistas redefinidas ao padrão',
  'ocorrencia:apagada': 'Ocorrência apagada',
  'alinhamento:cancelado': 'Alinhamento cancelado',
  'checklist:apagado': 'Item do checklist apagado',
  'pergunta:apagada': 'Pergunta do gabarito apagada',
  'avaliacao:apagada': 'Avaliação apagada',
  'personagem:removido': 'Personagem removido',
});

/**
 * Valida o motivo (opcional). Devolve { valid, reason, error }: `reason` é o texto limpo ou null.
 * Mesma regra de kb_apagar_motivo no banco.
 */
export function validateReason(text) {
  const reason = String(text ?? '').trim();
  if (!reason) return { valid: true, reason: null, error: null };
  if ([...reason].length > REASON_MAX) return { valid: false, reason: null, error: APAGAR_ERRORS.reasonLength };
  if (hasEmoji(reason)) return { valid: false, reason: null, error: APAGAR_ERRORS.noEmoji };
  return { valid: true, reason, error: null };
}

/** O que foi digitado libera o botão das ações de alto impacto? (ignora espaços nas pontas, exige maiúsculas) */
export const confirmWordOk = (typed) => String(typed ?? '').trim() === CONFIRM_WORD;

/** Cada ação destrutiva: permissão, o que pede de confirmação e o texto que a janela mostra. */
export const DESTRUCTIVE = Object.freeze({
  character: {
    permission: 'personagens.apagar', typed: false, title: 'Remover o personagem?', confirmLabel: 'Remover personagem',
    lose: 'O personagem sai da lista e o nome e o ID da Cidade ficam livres de novo (o nome deixa de ser bloqueado na allowlist). Os dados ficam guardados na auditoria.',
  },
  session: {
    permission: 'escalas.cancelar', typed: false, title: 'Cancelar a sessão?', confirmLabel: 'Cancelar sessão',
    lose: 'A sessão é marcada como cancelada e as pessoas escaladas recebem um aviso no privado, se o bot estiver configurado.',
  },
  escala: {
    permission: 'escalas.cancelar', typed: false, title: 'Fechar a escala?', confirmLabel: 'Fechar escala',
    lose: 'A escala deixa de estar ativa e você poderá abrir uma nova. As sessões já criadas continuam na agenda. Os horários da escala ficam guardados na auditoria.',
  },
  config: {
    permission: 'escalas.redefinir', typed: false, title: 'Redefinir as configurações?', confirmLabel: 'Redefinir ao padrão',
    lose: 'Dias, horários, aviso antes da entrevista e a mensagem para copiar voltam ao padrão. Canais e cargos do Discord ficam como estão. Os valores de agora ficam na auditoria.',
  },
  evaluation: {
    permission: 'avaliacoes.apagar', typed: true, title: 'Apagar a avaliação?', confirmLabel: 'Apagar avaliação',
    lose: 'A avaliação inteira (notas, textos e as decisões da Diretoria ligadas a ela) sai do sistema. Uma cópia completa fica só na auditoria. Não dá para desfazer.',
  },
  occurrence: {
    permission: 'ocorrencias.apagar', typed: true, title: 'Apagar a ocorrência?', confirmLabel: 'Apagar ocorrência',
    lose: 'A ocorrência sai do histórico do membro. O texto completo fica só na auditoria. Não dá para desfazer.',
  },
  alignment: {
    permission: 'alinhamentos.apagar', typed: false, title: 'Cancelar o alinhamento?', confirmLabel: 'Cancelar alinhamento',
    lose: 'O alinhamento fica marcado como cancelado. A mensagem que já foi para o privado não some, e a reunião da Agenda (se houver) precisa ser apagada por lá.',
  },
  question: {
    permission: 'gabarito.apagar', typed: true, title: 'Apagar a pergunta para sempre?', confirmLabel: 'Apagar pergunta',
    lose: 'A pergunta sai do gabarito. As entrevistas antigas continuam com a cópia do texto. Não dá para desfazer; prefira Desativar se for só parar de usar.',
  },
  item: {
    permission: 'gabarito.apagar', typed: true, title: 'Apagar o item do checklist para sempre?', confirmLabel: 'Apagar item',
    lose: 'O item sai do checklist. Não dá para desfazer; prefira Desativar se for só parar de usar.',
  },
});
