// Cadastros do AGRO FÁCIL guardados no servidor: destinatários, romaneios e
// notas salvas (preenchidas e ainda não enviadas). O aplicativo guarda uma
// cópia no aparelho e sincroniza aqui, para não perder nada ao limpar o
// navegador e para ver o mesmo no celular e no PC.
//
// Sincronizar = o app manda o que tem, o servidor junta com o que já tinha
// (vale a versão mais nova de cada id, por "atualizadoEm") e devolve tudo.
// Item apagado vira { id, atualizadoEm, removido: true }, para sumir também nos
// outros aparelhos; fica guardado assim por 60 dias.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TIPOS_CADASTRO = ['destinatarios', 'romaneios', 'notas'];
export const MAX_ITENS = 5000;
const ID = /^[\w-]{1,48}$/;
const GUARDA_APAGADOS_MS = 60 * 864e5;

const valido = (x) => x && typeof x === 'object' && !Array.isArray(x) && typeof x.id === 'string' && ID.test(x.id) && typeof x.atualizadoEm === 'string' && !Number.isNaN(Date.parse(x.atualizadoEm));

/** Junta duas listas: por id, fica a versão mais nova (no empate, a primeira). */
export function juntar(primeira, segunda, agora = Date.now()) {
  const porId = new Map();
  for (const x of [...primeira, ...segunda]) {
    if (!valido(x)) continue;
    const atual = porId.get(x.id);
    if (!atual || Date.parse(x.atualizadoEm) > Date.parse(atual.atualizadoEm)) {
      porId.set(x.id, x.removido ? { id: x.id, atualizadoEm: x.atualizadoEm, removido: true } : x);
    }
  }
  return [...porId.values()].filter((x) => !x.removido || agora - Date.parse(x.atualizadoEm) < GUARDA_APAGADOS_MS);
}

export function criarCadastros(pasta) {
  const arquivo = (tipo) => join(pasta, 'cadastros-' + tipo + '.json');
  const ler = (tipo) => {
    try {
      const l = JSON.parse(readFileSync(arquivo(tipo), 'utf8'));
      return Array.isArray(l) ? l : [];
    } catch {
      return [];
    }
  };
  return {
    listar: ler,
    sincronizar(tipo, itens) {
      const juntos = juntar(ler(tipo), itens);
      writeFileSync(arquivo(tipo), JSON.stringify(juntos));
      return juntos;
    },
  };
}
