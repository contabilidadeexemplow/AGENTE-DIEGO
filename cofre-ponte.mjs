// Cofre da PONTE: quando este servidor é o robô de um cliente publicado pela
// PONTE SEFAZ, a senha do SIARE de cada produtor NÃO mora aqui. Ela vive no
// cofre da PONTE, selada por (cliente, inscrição), e só a chave de escopo
// "robo" deste cliente a abre (regra do CLAUDE.md da PONTE). Guardar uma cópia
// aqui seria a segunda credencial fora de lá, que é exatamente o que a regra
// proíbe — então o robô pergunta a cada login e não grava a resposta.
//
// Mesmo formato do cofre local (credencial, lista, guardar, remover), para o
// resto do servidor não saber qual dos dois está ligado.

const digitos = (s) => String(s ?? '').replace(/\D/g, '');

/** O cliente pausado, como o produtor deve ler (a mesma tabela do site). */
export const LICENCA_PARADA = Object.freeze({
  'cliente-inadimplente':
    'Acesso pausado por pendência financeira. Volta a funcionar assim que o pagamento for '
    + 'identificado — nada do que você já fez foi perdido.',
  'cliente-suspenso': 'Acesso suspenso. Procure o responsável pelo sistema.',
  'cliente-cancelado': 'Este acesso foi encerrado. Procure o responsável pelo sistema.',
  'cliente-rascunho': 'Este acesso ainda não foi liberado. Procure o responsável pelo sistema.',
});

export function criarCofreDaPonte({ url, chave, buscar = fetch, tetoMs = 20000 }) {
  const base = String(url || '').replace(/\/+$/, '');
  if (!base || !chave) throw new Error('O cofre da PONTE precisa de PONTE_URL e PONTE_CHAVE_ROBO.');
  return {
    daPonte: true,
    /**
     * A credencial do produtor, perguntada à PONTE agora.
     * A recusa da PONTE (sem senha cadastrada, termo pendente) volta como erro
     * com o texto dela: é ele que diz ao produtor o que fazer.
     */
    async credencial(ie) {
      const controle = new AbortController();
      const relogio = setTimeout(() => controle.abort(), tetoMs);
      let r;
      try {
        r = await buscar(base + '/api/campo/robo/credencial', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': chave },
          body: JSON.stringify({ ie: digitos(ie) }),
          signal: controle.signal,
        });
      } catch {
        throw new Error('A PONTE não respondeu ao pedir a senha do SIARE. Nada foi enviado. Tente de novo em instantes.');
      } finally {
        clearTimeout(relogio);
      }
      let corpo = {};
      try { corpo = await r.json(); } catch { /* corpo vazio */ }
      // Cliente pausado (mensalidade, suspensão): a PONTE recusa a chave com um
      // `codigo`, e a frase dela é para o operador. Quem lê aqui é o produtor.
      if (r.status === 401 && LICENCA_PARADA[corpo.codigo]) throw new Error(LICENCA_PARADA[corpo.codigo]);
      // A tela do AGRO FÁCIL nunca fala em robô: o nome da variável vai para o
      // log do servidor, e o produtor lê o que fazer.
      if (r.status === 401) {
        console.error('[cofre-ponte] a PONTE recusou PONTE_CHAVE_ROBO (401). Confira a variável no Render.');
        throw new Error('A PONTE recusou o servidor deste site. Fale com quem instalou.');
      }
      if (!r.ok) throw new Error(corpo.erro || `A PONTE respondeu ${r.status} ao pedir a senha do SIARE.`);
      const c = corpo.credencial || {};
      if (!c.senha || digitos(c.cpf).length !== 11) throw new Error('A PONTE devolveu uma credencial incompleta para esta inscrição.');
      return Object.freeze({ cpf: digitos(c.cpf), senha: c.senha, dominio: 'Produtor Rural' });
    },
    /** Quais IEs têm senha: quem sabe é a PONTE; daqui não se lista. */
    lista: () => [],
    guardar() {
      throw new Error('A senha do SIARE de cada produtor é cadastrada no painel da PONTE.');
    },
    remover() {
      throw new Error('A senha do SIARE de cada produtor é removida no painel da PONTE.');
    },
  };
}
