// ============================================================
//  Custo 3D - sincronização com o Supabase
//  Tudo o que a calculadora grava (chaves "calc3d-...") continua
//  no navegador como cópia local e também vai para a tabela
//  public.custo3d_dados do seu projeto Supabase.
//  Sem internet: as alterações ficam numa fila e são enviadas
//  quando a conexão voltar.
// ============================================================
(function () {
  "use strict";
  const P = "calc3d-";                       // prefixo das chaves que vão para a nuvem
  const SES = "c3dsync-sessao";              // sessão do Supabase Auth
  const USR = "c3dsync-usuario";             // id do usuário já sincronizado neste aparelho
  const FILA = "c3dsync-fila";               // alterações ainda não enviadas
  const META = "c3dsync-meta";               // data da última versão recebida de cada chave
  const TABELA = "custo3d_dados";
  const TEMPO_LIMITE = 10000;

  const ls = window.localStorage;
  const origSet = Storage.prototype.setItem;
  const origRem = Storage.prototype.removeItem;
  const $ = (id) => document.getElementById(id);
  const lerJ = (k, f) => { try { const r = ls.getItem(k); return r ? JSON.parse(r) : f; } catch (e) { return f; } };
  const gravarJ = (k, v) => { try { origSet.call(ls, k, JSON.stringify(v)); } catch (e) {} };
  const apagar = (k) => { try { origRem.call(ls, k); } catch (e) {} };

  // Projeto Supabase fixo (a chave publishable é pública por natureza;
  // quem protege os dados é o login + as regras RLS da tabela)
  const cfg = {
    url: "https://jdhwwwhqikovgfwgcixw.supabase.co",
    chave: "sb_publishable_4aYwTogzqnONSlO83eIxUQ_FHZ-kMNX"
  };
  let sessao = lerJ(SES, null);
  let fila = lerJ(FILA, {});
  let meta = lerJ(META, {});
  let pronto = false;
  let enviando = false;
  let tmr = null;
  let semRede = false;

  const configurado = () => !!(cfg && cfg.url && cfg.chave);
  const logado = () => !!(configurado() && sessao && sessao.refresh_token && sessao.user);
  const vinculado = () => configurado() && !!ls.getItem(USR);

  // ---------- Intercepta o que a calculadora grava ----------
  Storage.prototype.setItem = function (k, v) {
    origSet.call(this, k, v);
    if (this === ls && typeof k === "string" && k.startsWith(P)) marcar(k, "set");
  };
  Storage.prototype.removeItem = function (k) {
    origRem.call(this, k);
    if (this === ls && typeof k === "string" && k.startsWith(P)) marcar(k, "del");
  };

  function marcar(k, op) {
    if (!vinculado()) return;
    fila[k] = { op, em: new Date().toISOString() };
    gravarJ(FILA, fila);
    statusFila();
    agendar(800);
  }
  function agendar(ms) { clearTimeout(tmr); tmr = setTimeout(enviar, ms); }

  // ---------- HTTP ----------
  async function req(caminho, op, auth) {
    op = op || {};
    const h = Object.assign({ apikey: cfg.chave, "Content-Type": "application/json" }, op.headers || {});
    if (auth !== false) h.Authorization = "Bearer " + (await token());
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TEMPO_LIMITE);
    try {
      const res = await fetch(cfg.url.replace(/\/+$/, "") + caminho, { method: op.method || "GET", headers: h, body: op.body, signal: ctrl.signal });
      const txt = await res.text();
      let j = null; try { j = txt ? JSON.parse(txt) : null; } catch (e) {}
      semRede = false;
      if (!res.ok) {
        const e = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ("Erro " + res.status));
        e.status = res.status; throw e;
      }
      return j;
    } catch (e) {
      if (e.name === "AbortError" || e instanceof TypeError) semRede = true;
      if (e.name === "AbortError") { const x = new Error("Sem resposta do Supabase"); x.offline = true; throw x; }
      if (e instanceof TypeError) { const x = new Error("Sem conexão com a internet"); x.offline = true; throw x; }
      throw e;
    } finally { clearTimeout(t); }
  }

  function guardarSessao(r) {
    sessao = {
      access_token: r.access_token,
      refresh_token: r.refresh_token,
      expires_at: r.expires_at || Math.floor(Date.now() / 1000) + (r.expires_in || 3600),
      user: { id: r.user.id, email: r.user.email }
    };
    gravarJ(SES, sessao);
  }

  async function token() {
    if (!sessao) throw new Error("Não conectado");
    if (sessao.access_token && sessao.expires_at * 1000 > Date.now() + 60000) return sessao.access_token;
    try {
      const r = await req("/auth/v1/token?grant_type=refresh_token", { method: "POST", body: JSON.stringify({ refresh_token: sessao.refresh_token }) }, false);
      guardarSessao(r);
      return sessao.access_token;
    } catch (e) {
      if (!e.offline && (e.status === 400 || e.status === 401)) {
        sessao = null; apagar(SES);
        abrirLogin(); const x = new Error("Sessão expirada. Toque em ☁ para entrar de novo."); x.sessao = true; throw x;
      }
      throw e;
    }
  }

  // ---------- Enviar alterações ----------
  async function enviar() {
    if (!logado() || !pronto || enviando) return;
    const ks = Object.keys(fila);
    if (!ks.length) { statusFila(); return; }
    enviando = true;
    const foto = Object.assign({}, fila);
    try {
      const linhas = [];
      ks.filter((k) => foto[k].op === "set").forEach((k) => {
        const r = ls.getItem(k);
        if (r === null) return;
        let v; try { v = JSON.parse(r); } catch (e) { v = r; }
        if (v === null || v === undefined) return;
        linhas.push({ user_id: sessao.user.id, chave: k, valor: v, atualizado_em: foto[k].em });
      });
      // envia em lotes de até ~1,5 MB (fotos pesam)
      let lote = [], tam = 0;
      const mandar = async () => {
        if (!lote.length) return;
        await req("/rest/v1/" + TABELA + "?on_conflict=user_id,chave", {
          method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify(lote)
        });
        lote = []; tam = 0;
      };
      for (const l of linhas) {
        const t = JSON.stringify(l).length;
        if (lote.length && tam + t > 1500000) await mandar();
        lote.push(l); tam += t;
      }
      await mandar();

      const dels = ks.filter((k) => foto[k].op === "del");
      for (let i = 0; i < dels.length; i += 40) {
        const lista = dels.slice(i, i + 40).map((k) => '"' + k.replace(/["\\]/g, "") + '"').join(",");
        await req("/rest/v1/" + TABELA + "?chave=in.(" + encodeURIComponent(lista) + ")", { method: "DELETE", headers: { Prefer: "return=minimal" } });
      }

      ks.forEach((k) => {
        if (fila[k] && fila[k].em === foto[k].em) {
          if (foto[k].op === "set") meta[k] = Date.parse(foto[k].em); else delete meta[k];
          delete fila[k];
        }
      });
      gravarJ(FILA, fila); gravarJ(META, meta);
      status("Nuvem sincronizada", "ok");
      if (Object.keys(fila).length) agendar(300);
    } catch (e) {
      status(e.sessao ? e.message : (e.offline ? "Sem conexão — alterações guardadas, envio depois" : "Erro ao enviar: " + e.message), "erro");
      if (!e.sessao) agendar(30000);
    } finally { enviando = false; statusFila(); }
  }

  // ---------- Receber dados ----------
  async function baixarTudo() {
    const todas = [];
    for (let off = 0; ; off += 200) {
      const r = await req("/rest/v1/" + TABELA + "?select=chave,valor,atualizado_em&order=chave&limit=200&offset=" + off);
      todas.push(...r);
      if (r.length < 200) break;
    }
    return todas;
  }
  const chavesLocais = () => { const k = []; for (let i = 0; i < ls.length; i++) { const n = ls.key(i); if (n && n.startsWith(P)) k.push(n); } return k; };
  // configurações que a calculadora grava sozinha ao abrir não contam como "dados"
  const AUTO = ["calc3d-etq-tam", "calc3d-config-v2", "calc3d-extras-v1"];
  const temDadosLocais = () => chavesLocais().some((k) => !AUTO.includes(k));

  function aplicar(linha) {
    try { origSet.call(ls, linha.chave, JSON.stringify(linha.valor)); meta[linha.chave] = Date.parse(linha.atualizado_em); }
    catch (e) { /* sem espaço local: fica só na nuvem */ }
  }
  function enfileirarTudoLocal() {
    const agora = new Date().toISOString();
    chavesLocais().forEach((k) => (fila[k] = { op: "set", em: agora }));
  }

  async function puxar() {
    const remotas = await baixarTudo();
    const remoto = {};
    remotas.forEach((l) => (remoto[l.chave] = l));
    const uid = sessao.user.id;

    if (ls.getItem(USR) !== uid) {
      // primeira sincronização deste aparelho com esta conta
      if (!remotas.length) {
        enfileirarTudoLocal();                       // leva os dados atuais para a nuvem
      } else if (temDadosLocais() && !confirm(
        "Já existem dados do Custo 3D na nuvem.\n\n" +
        "OK = usar os dados da NUVEM neste aparelho (os daqui serão substituídos)\n" +
        "Cancelar = enviar os dados DESTE aparelho para a nuvem (os da nuvem serão substituídos)\n\n" +
        "Dica: antes de escolher, você pode copiar o backup.")) {
        fila = {}; enfileirarTudoLocal();
        const agora = new Date().toISOString();
        Object.keys(remoto).forEach((k) => { if (!fila[k]) fila[k] = { op: "del", em: agora }; });
      } else {
        fila = {};
        chavesLocais().forEach((k) => { if (!remoto[k]) apagar(k); });
        remotas.forEach(aplicar);
      }
      origSet.call(ls, USR, uid);
    } else {
      // sincronização normal: o que está pendente aqui vale; o resto vem da nuvem
      remotas.forEach((l) => {
        if (fila[l.chave]) return;
        if (meta[l.chave] !== Date.parse(l.atualizado_em) || ls.getItem(l.chave) === null) aplicar(l);
      });
      chavesLocais().forEach((k) => { if (!remoto[k] && !fila[k]) { apagar(k); delete meta[k]; } });
    }
    gravarJ(FILA, fila); gravarJ(META, meta);
  }

  // ---------- Tela ----------
  function status(msg, tipo) {
    const chip = $("nuvemChip"), st = $("sbStatus");
    if (chip) { chip.hidden = false; chip.textContent = "☁ " + msg; chip.className = "nuvem" + (tipo ? " " + tipo : ""); }
    if (st) st.textContent = msg;
  }
  function statusFila() {
    const n = Object.keys(fila).length;
    if (!logado()) {
      status("Não conectado · toque para entrar", "erro");
      return;
    }
    if (n) status((semRede ? "Sem conexão · " : "") + n + (n === 1 ? " alteração" : " alterações") + " aguardando envio", semRede ? "erro" : "");
  }
  function aviso(msg) { const el = $("toastSb"); if (!el) return; el.textContent = msg; clearTimeout(el._t); el._t = setTimeout(() => (el.textContent = ""), 3500); }

  function abrirLogin() {
    const m = $("sbModal"); if (!m || !m.hidden) return;
    if (sessao && sessao.user && !$("sbEmail").value) $("sbEmail").value = sessao.user.email;
    m.hidden = false;
    setTimeout(() => ($("sbEmail").value ? $("sbSenha") : $("sbEmail")).focus(), 50);
  }
  function fecharLogin() { const m = $("sbModal"); if (m) m.hidden = true; }

  async function sair() {
    status("Enviando alterações…", "");
    try { pronto = true; await enviar(); } catch (e) {}
    const n = Object.keys(fila).length;
    if (n && !confirm(n + " alteração(ões) ainda não foram para a nuvem e serão perdidas. Sair mesmo assim?")) { statusFila(); return; }
    try { await req("/auth/v1/logout", { method: "POST" }); } catch (e) {}
    chavesLocais().forEach(apagar);
    [SES, USR, FILA, META].forEach(apagar);
    location.reload();
  }

  function ligarTela() {
    $("sbForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const email = $("sbEmail").value.trim(), senha = $("sbSenha").value;
      if (!email || !senha) { aviso("Preencha e-mail e senha"); return; }
      aviso("Entrando…");
      $("btnSbEntrar").disabled = true;
      try {
        const r = await req("/auth/v1/token?grant_type=password", { method: "POST", body: JSON.stringify({ email, password: senha }) }, false);
        const trocouConta = sessao && sessao.user && sessao.user.id !== r.user.id;
        guardarSessao(r);
        if (trocouConta) { apagar(USR); fila = {}; meta = {}; gravarJ(FILA, fila); gravarJ(META, meta); }
        $("sbSenha").value = "";
        await puxar();
        pronto = true;
        await enviar();
        aviso("Pronto! Recarregando…");
        setTimeout(() => location.reload(), 700);
      } catch (e) {
        aviso(/invalid login|invalid_grant/i.test(e.message) ? "E-mail ou senha incorretos" : e.message);
      } finally { $("btnSbEntrar").disabled = false; }
    });

    // ☁ no topo: sem login abre a tela de entrar; logado sincroniza agora ou sai da conta
    const chip = $("nuvemChip");
    const clicarChip = async () => {
      if (!logado()) { abrirLogin(); return; }
      if (!confirm("Conectado como " + sessao.user.email + ".\n\nOK = sair da conta (os dados deste aparelho são apagados; continuam na nuvem)\nCancelar = continuar usando")) return;
      sair();
    };
    chip.addEventListener("click", clicarChip);
    chip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); clicarChip(); } });

    window.addEventListener("online", () => { if (logado()) { pronto = true; agendar(500); } });
  }

  // ---------- Início ----------
  let iniciado = false;
  function abrirApp() {
    if (iniciado) return; iniciado = true;
    try { window.iniciarCusto3D(); } catch (e) { console.error(e); }
  }

  // ---------- Atualizar sem fechar o app ----------
  // Busca o que mudou na nuvem (ex.: produto cadastrado em outro aparelho)
  // e avisa a tela com o evento "nuvem-atualizada".
  let puxando = null, ultimaPuxada = Date.now();
  window.nuvemAtualizar = function (forcar) {
    if (!logado() || !iniciado) return Promise.resolve(false);
    if (puxando) return puxando;
    if (!forcar && Date.now() - ultimaPuxada < 20000) return Promise.resolve(false);
    ultimaPuxada = Date.now();
    puxando = (async () => {
      try { pronto = true; await enviar(); } catch (e) {}
      try {
        await puxar(); statusFila();
        window.dispatchEvent(new Event("nuvem-atualizada"));
        return true;
      } catch (e) { return false; }
      finally { puxando = null; }
    })();
    return puxando;
  };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") window.nuvemAtualizar(); });
  window.addEventListener("focus", () => window.nuvemAtualizar());

  ligarTela();
  if (logado() && vinculado()) {
    status("Sincronizando…", "");
    puxar()
      .then(() => status("Nuvem sincronizada", "ok"))
      .catch((e) => status(e.sessao ? e.message : (e.offline ? "Sem conexão — usando dados deste aparelho" : "Erro: " + e.message), "erro"))
      .finally(() => { pronto = true; abrirApp(); statusFila(); enviar(); });
  } else {
    // sem login o sistema não abre
    statusFila();
    abrirLogin();
  }
})();
