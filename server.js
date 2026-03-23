// MCP Server - Dolibarr
// Version 1.3 - stateless mode

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DOLIBARR_BASE = "https://nicolasclimatisation.with10.dolicloud.com/api/index.php/v1";
const PORT = process.env.PORT || 3000;

function getApiKey() {
  const key = process.env.DOLIBARR_API_KEY;
  if (!key) throw new Error("DOLIBARR_API_KEY manquante");
  return key;
}

async function doliGet(path) {
  const res = await fetch(`${DOLIBARR_BASE}${path}`, {
    headers: { "DOLAPIKEY": getApiKey(), "Content-Type": "application/json", "Accept": "application/json" }
  });
  if (!res.ok) throw new Error(`GET ${path} HTTP ${res.status}`);
  return res.json();
}

async function doliPost(path, payload) {
  const res = await fetch(`${DOLIBARR_BASE}${path}`, {
    method: "POST",
    headers: { "DOLAPIKEY": getApiKey(), "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`POST ${path} HTTP ${res.status}`);
  return res.json();
}

function buildServer() {
  const s = new McpServer({ name: "dolibarr-vincent", version: "1.0.0" });

  s.tool("get_factures_impayees", "Factures clients impayees triees par echeance.", {}, async () => {
    const data = await doliGet("/invoices?status=unpaid&sortfield=t.date_lim_reglement&sortorder=ASC&limit=20");
    const factures = (Array.isArray(data) ? data : []).map(f => ({
      id: f.id, ref: f.ref, client: f.socnom, socid: f.socid,
      montant_ttc: parseFloat(f.total_ttc || 0),
      echeance: f.date_lim_reglement ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0] : null,
      retard_jours: f.date_lim_reglement ? Math.floor((Date.now() - f.date_lim_reglement * 1000) / 86400000) : 0,
      statut: f.statut_libelle || ""
    }));
    return { content: [{ type: "text", text: JSON.stringify({ factures, total: factures.length }) }] };
  });

  s.tool("get_factures_fournisseurs_en_attente", "Factures fournisseurs non payees triees par echeance.", {}, async () => {
    const data = await doliGet("/supplierinvoices?status=0&sortfield=t.date_lim_reglement&sortorder=ASC&limit=20");
    const factures = (Array.isArray(data) ? data : []).map(f => ({
      id: f.id, ref: f.ref, fournisseur: f.socnom,
      montant_ttc: parseFloat(f.total_ttc || 0),
      echeance: f.date_lim_reglement ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0] : null
    }));
    return { content: [{ type: "text", text: JSON.stringify({ factures, total: factures.length }) }] };
  });

  s.tool("get_factures_client", "10 dernieres factures d'un client.", { socid: z.string() }, async ({ socid }) => {
    const data = await doliGet(`/invoices?thirdparty_ids=${socid}&sortfield=t.rowid&sortorder=DESC&limit=10`);
    const factures = (Array.isArray(data) ? data : []).map(f => ({
      id: f.id, ref: f.ref, montant_ttc: parseFloat(f.total_ttc || 0),
      date: f.date ? new Date(f.date * 1000).toISOString().split("T")[0] : null,
      echeance: f.date_lim_reglement ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0] : null,
      statut: f.statut, statut_libelle: f.statut_libelle || ""
    }));
    return { content: [{ type: "text", text: JSON.stringify({ factures, total: factures.length }) }] };
  });

  s.tool("find_thirdparty_by_email", "Cherche un tiers par email.", { email: z.string() }, async ({ email }) => {
    const data = await doliGet(`/thirdparties?email=${encodeURIComponent(email)}&limit=1`);
    const tiers = Array.isArray(data) && data.length > 0
      ? { id: data[0].id, nom: data[0].name, email: data[0].email, telephone: data[0].phone, adresse: data[0].address, code_client: data[0].code_client }
      : null;
    return { content: [{ type: "text", text: JSON.stringify({ tiers }) }] };
  });

  s.tool("get_thirdparty", "Fiche complete d'un tiers.", { socid: z.string() }, async ({ socid }) => {
    const data = await doliGet(`/thirdparties/${socid}`);
    const tiers = data ? {
      id: data.id, nom: data.name, email: data.email, telephone: data.phone,
      adresse: data.address, code_postal: data.zip, ville: data.town,
      code_client: data.code_client,
      url_dolibarr: `https://nicolasclimatisation.with10.dolicloud.com/societe/card.php?socid=${data.id}`
    } : null;
    return { content: [{ type: "text", text: JSON.stringify({ tiers }) }] };
  });

  s.tool("create_facture_from_devis", "Cree une facture depuis un devis. ECRITURE apres validation Vincent.",
    { proposalId: z.string(), socid: z.string() },
    async ({ proposalId, socid }) => {
      const proposal = await doliGet(`/proposals/${proposalId}`);
      if (!proposal) throw new Error(`Devis ${proposalId} introuvable`);
      const factureId = await doliPost("/invoices", {
        socid, fk_proposal: proposalId, date: Math.floor(Date.now() / 1000),
        cond_reglement_id: proposal.cond_reglement_id || 1, lines: proposal.lines || []
      });
      await doliPost(`/invoices/${factureId}/validate`, { notrigger: 0 });
      return { content: [{ type: "text", text: JSON.stringify({ succes: true, facture_id: factureId }) }] };
    }
  );

  s.tool("create_facture_fournisseur", "Cree une facture fournisseur. ECRITURE apres validation Vincent.",
    { socid: z.string(), montantHT: z.number(), tauxTva: z.number(), echeance: z.string(), description: z.string() },
    async ({ socid, montantHT, tauxTva, echeance, description }) => {
      const factureId = await doliPost("/supplierinvoices", {
        socid, date: Math.floor(Date.now() / 1000),
        date_lim_reglement: Math.floor(new Date(echeance).getTime() / 1000),
        lines: [{ desc: description, subprice: montantHT, qty: 1, tva_tx: tauxTva }]
      });
      return { content: [{ type: "text", text: JSON.stringify({ succes: true, facture_id: factureId }) }] };
    }
  );

  return s;
}

// --- Express ---

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// Point d'entree MCP - mode stateless (nouveau transport)
app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[MCP] Erreur:", err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// Point d'entree SSE - ancien transport (compatibilite)
app.get("/mcp", (req, res) => {
  res.status(200).json({ status: "MCP server ready", transport: "streamable-http", version: "1.3.0" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dolibarr-mcp-server", version: "1.3.0", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`MCP Dolibarr v1.3 started on port ${PORT}`);
});
