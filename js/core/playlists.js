// Playlists pessoais de perguntas do gabarito (SQL 27).
// Regras puras usadas pelo mock, pelo supabase-adapter e pelas telas. Quem garante de verdade é o banco
// (funções do 27 conferem o dono); as mensagens abaixo são IGUAIS às do SQL (tests/db/banco.test.mjs confere).
import { hasEmoji, NO_EMOJI_MESSAGE } from './workflow.js';

export const PLAYLIST_MAX = 10;
export const PLAYLIST_NAME_MAX = 50;

export const PLAYLIST_ERRORS = Object.freeze({
  forbidden: 'Seu cargo não usa o gabarito das entrevistas.',
  notInstalled: 'As playlists ainda não foram instaladas no banco de dados (falta rodar o SQL 27).',
  nameEmpty: 'Dê um nome para a playlist.',
  nameLength: `O nome da playlist pode ter até ${PLAYLIST_NAME_MAX} caracteres.`,
  noEmoji: NO_EMOJI_MESSAGE,
  limit: `Você já tem ${PLAYLIST_MAX} playlists. Apague uma para criar outra.`,
  notFound: 'Playlist não encontrada.',
  question: 'Pergunta não encontrada.',
});

/** @returns {{ valid: boolean, name: string, error: string }} nome sem espaços nas pontas. */
export function validatePlaylistName(input) {
  const name = String(input ?? '').trim();
  if (!name) return { valid: false, name, error: PLAYLIST_ERRORS.nameEmpty };
  if (name.length > PLAYLIST_NAME_MAX) return { valid: false, name, error: PLAYLIST_ERRORS.nameLength };
  if (hasEmoji(name)) return { valid: false, name, error: PLAYLIST_ERRORS.noEmoji };
  return { valid: true, name, error: '' };
}

/** Pode criar mais uma? */
export const canCreatePlaylist = (count) => count < PLAYLIST_MAX;

/**
 * Perguntas a mostrar no gabarito: todas (sem playlist) ou só as da playlist, na ordem dela.
 * @param {{ id: string }[]} all todas as perguntas ativas, na ordem do gabarito
 * @param {string[]|null} playlistIds ids da playlist na ordem dela; null = todas
 */
export function questionsForPlaylist(all, playlistIds) {
  if (!playlistIds) return all;
  const byId = new Map(all.map((q) => [q.id, q]));
  return playlistIds.map((id) => byId.get(id)).filter(Boolean);
}

/** Textos de busca e filtro do seletor de perguntas (texto, resposta e tipo/seção). */
export function filterQuestions(questions, { query = '', section = '' } = {}) {
  const q = String(query).trim().toLowerCase();
  return questions.filter((x) => (!section || x.section === section)
    && (!q || `${x.question} ${x.answer ?? ''}`.toLowerCase().includes(q)));
}
