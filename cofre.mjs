// Cofre das senhas do SIARE. A senha é guardada no servidor, cifrada com
// AES-256-GCM, no arquivo dados/credenciais.json. A chave vem de um segredo
// do ambiente (SEGREDO_CREDENCIAIS no Render) ou, no PC, de uma chave local
// gerada uma vez em dados/.chave-credenciais.
//
// A senha decifrada só sai daqui para o campo do SIARE, no momento do login.
// Nunca vai para log, print, pedido nem resposta da API.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const digitos = (s) => String(s ?? '').replace(/\D/g, '');

/** Chave local do PC, gerada uma vez e guardada na pasta de dados. */
export function chaveLocal(dir) {
  const arq = join(dir, '.chave-credenciais');
  try { return readFileSync(arq, 'utf8').trim(); } catch { /* ainda não existe */ }
  const nova = randomBytes(32).toString('hex');
  mkdirSync(dir, { recursive: true });
  writeFileSync(arq, nova, { mode: 0o600 });
  try { chmodSync(arq, 0o600); } catch { /* o Windows ignora */ }
  return nova;
}

export function criarCofre({ arquivo, segredo, base = new Map() }) {
  const chave = createHash('sha256').update('agro-facil:credenciais:' + segredo).digest(); // 32 bytes
  let guardadas = new Map(); // ie → { cpf, dominio, senhaCifrada }
  try {
    const o = JSON.parse(readFileSync(arquivo, 'utf8'));
    for (const [ie, v] of Object.entries(o)) guardadas.set(ie, v);
  } catch { /* ainda não há cofre */ }

  const salvar = () => {
    mkdirSync(dirname(arquivo), { recursive: true });
    writeFileSync(arquivo, JSON.stringify(Object.fromEntries(guardadas)), { mode: 0o600 });
    try { chmodSync(arquivo, 0o600); } catch { /* o Windows ignora */ }
  };
  const cifrar = (senha) => {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', chave, iv);
    const dados = Buffer.concat([c.update(String(senha), 'utf8'), c.final()]);
    return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), dados: dados.toString('base64') };
  };
  const decifrar = (s) => {
    const d = createDecipheriv('aes-256-gcm', chave, Buffer.from(s.iv, 'base64'));
    d.setAuthTag(Buffer.from(s.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(s.dados, 'base64')), d.final()]).toString('utf8');
  };

  return {
    /** Guarda (ou troca) a senha de uma IE. */
    guardar({ ie, cpf, senha, dominio }) {
      const chaveIe = digitos(ie);
      if (chaveIe.length !== 13) throw new Error('A IE tem 13 dígitos.');
      if (digitos(cpf).length !== 11) throw new Error('O CPF tem 11 dígitos.');
      if (!senha || typeof senha !== 'string') throw new Error('Informe a senha.');
      guardadas.set(chaveIe, { cpf: digitos(cpf), dominio: dominio || 'Produtor Rural', senhaCifrada: cifrar(senha) });
      salvar();
    },
    remover(ie) {
      const t = guardadas.delete(digitos(ie));
      salvar();
      return t;
    },
    tem(ie) {
      const k = digitos(ie);
      return guardadas.has(k) || base.has(k);
    },
    /** Credencial completa para o login. Devolve null se não houver (nunca é logada). */
    credencial(ie) {
      const k = digitos(ie);
      if (guardadas.has(k)) {
        const g = guardadas.get(k);
        try { return { cpf: g.cpf, dominio: g.dominio, senha: decifrar(g.senhaCifrada) }; } catch { return null; }
      }
      return base.get(k) || null;
    },
    /** Só o que é seguro mostrar: quais IEs têm senha e de onde veio. Nunca a senha. */
    lista() {
      const ies = new Set([...guardadas.keys(), ...base.keys()]);
      return [...ies].map((ie) => ({ ie, origem: guardadas.has(ie) ? 'app' : 'segredo' }));
    },
  };
}
