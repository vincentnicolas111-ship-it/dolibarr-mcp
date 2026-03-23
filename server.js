// MCP Server - Dolibarr
// Assistant IA - Vincent x Claude
// Version 1.2 - 2026-03-23 - Streamable HTTP transport

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// --- Configuration ---
const DOLIBARR_BASE = "https://nicolasclimatisation.with10.dolicloud.com/api/index.php/v1";
const PORT = process.env.PORT || 3000;

function getApiKey() {
  const key = process.env.DOLIBARR_API_KEY;
  if (!key) throw new Error("DOLIBARR_API_KEY manquante");
  return key;
}

// --- Client HTTP Dolibarr ---

async function doliGet(path) {
  const res = await fetch(`${DOLIBARR_BASE}${path}`, {
    headers: {
      "DOLAPIKEY": getApiKey(),
      "Content-Type": "application/json",
      "Accept": "application/json"
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dolibarr GET ${path} - HTTP ${res.status} : ${body}`);
  }
  return res.json();
}

async function doliPost(path, payload) {
  const res = await fetch(`${DOLIBARR_BASE}${path}`, {
    method: "POST",
    headers: {
      "DOLAPIKEY": getApiKey(),
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dolibarr POST ${path} - HTTP ${res.status} : ${body}`);
  }
  return res.json();
}

// --- Serveur MCP ---

function createMcpServer() {
  const server = new McpServer({
    name: "dolibarr-vincent",
    version: "1.0.0"
  });

  server.tool("get_factures_impayees",
    "Recupere toutes les factures clients impayees, triees par echeance.",
    {},
    async () => {
      const data = await doliGet("/invoices?status=unpaid&sortfield=t.date_lim_reglement&sortorder=ASC&limit=20");
      const factures = (Array.isArray(data) ? data : []).map(f => ({
        id: f.id, ref: f.ref, client: f.socnom, socid: f.socid,
        montant_ttc: parseFloat(f.total_ttc || 0),
        echeance: f.date_lim_reglement ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0] : null,
        retard_jours: f.date_lim_reglement ? Math.floor((Date.now() - f.date_lim_reglement * 1000) / 86400000) : 0,
        statut: f.statut_libelle || ""
      }));
      return { content: [{ type: "text", text: JSON.stringify({ factures, total: factures.length }) }] };
    }
  );

  server.tool("get_factures_fournisseurs_en_attente",
    "Recupere les factures fournisseurs non payees, triees par echeance.",
    {},
    async () => {
      const data = await doliGet("/supplierinvoices?status=0&sortfield=t.date_lim_reglement&sortorder=ASC&limit=20");
      const factures = (Array.isArray(data) ? data : []).map(f => ({
        id: f.id, ref: f.ref, fournisseur: f.socnom,
        montant_ttc: parseFloat(f.total_ttc || 0),
        echeance: f.date_lim_reglement ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0] : null
      }));
      return { content: [{ type: "text", text: JSON.stringify({ factures, total: factures.length }) }] };
    }
  );

  server.tool("get_factures_client",
    "Recupere les 10 dernieres factures d'un client Dolibarr par son socid.",
    { socid: z.string().describe("Identifiant numerique du tiers dans Dolibarr") },
    async ({ socid }) => {
      const data = await doliGet(`/invoices?thirdparty_ids=${socid}&sortfield=t.rowid&sortorder=DESC&limit=10`);
      const factures = (Array.isArray(data) ? data : []).map(f => ({
        id: f.id, ref: f.ref, montant_ttc: parseFloat(f.total_ttc || 0),
        date: f.date ? new Date(f.date * 1000).toISOString().split("T")[0] : null,
        echeance: f.date_lim_reglement ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0] : null,
        statut: f.statut, statut_libelle: f.statut_libelle || ""
      }));
      return { content: [{ type: "text", text: JSON.stringify({ factures, total: factures.length }) }] };
    }
  );

  server.tool("find_thirdparty_by_email",
    "Cherche un tiers Dolibarr par adresse email.",
    { email: z.string().describe("Adresse email a rechercher") },
    async ({ email }) => {
      const data = await doliGet(`/thirdparties?email=${encodeURIComponent(email)}&limit=1`);
      const tiers = Array.isArray(data) && data.length > 0 ? {
        id: data[0].id, nom: data[0].name, email: data[0].email,
        telephone: data[0].phone, adresse: data[0].address, code_client: data[0].code_client
      } : null;
      return { content: [{ type: "text", text: JSON.stringify({ tiers }) }] };
    }
  );

  server.tool("get_thirdparty",
    "Recupere la fiche complete d'un tiers Dolibarr par son identifiant.",
    { socid: z.string().describe("Identifiant numerique du tiers") },
    async ({ socid }) => {
      const data = await doliGet(`/thirdparties/${socid}`);
      const tiers = data ? {
        id: data.id, nom: data.name, email: data.email, telephone: data.phone,
        adresse: data.address, code_postal: data.zip, ville: data.town,
        code_client: data.code_client,
        url_dolibarr: `https://nicolasclimatisation.with10.dolicloud.com/societe/card.php?socid=${data.id}`
      } : null;
      return { content: [{ type: "text", text: JSON.stringify({ tiers }) }] };
    }
  );

  server.tool("create_facture_from_devis",
    "Cree et valide une facture Dolibarr depuis un devis. ECRITURE - apres validation de Vincent uniquement.",
    {
      proposalId: z.string().describe("Identifiant du devis Dolibarr"),
      socid: z.string().describe("Identifiant du client (socid)")
    },
    async ({ proposalId, socid }) => {
      const proposal = await doliGet(`/proposals/${proposalId}`);
      if (!proposal) throw new Error(`Devis ${proposalId} introuvable`);
      const factureId = await doliPost("/invoices", {
        socid, fk_proposal: proposalId,
        date: Math.floor(Date.now() / 1000),
        cond_reglement_id: proposal.cond_reglement_id || 1,
        lines: proposal.lines || []
      });
      if (!factureId) throw new Error("Creation facture echouee");
      await doliPost(`/invoices/${factureId}/validate`, { notrigger: 0 });
      return { content: [{ type: "text", text: JSON.stringify({ succes: true, facture_id: factureId }) }] };
    }
  );

  server.tool("create_facture_fournisseur",
    "Cree une facture fournisseur dans Dolibarr. ECRITURE - apres validation de Vincent uniquement.",
    {
      socid: z.string().describe("Identifiant du fournisseur"),
      montantHT: z.number().describe("Montant HT en euros"),
      tauxTva: z.number().describe("Taux TVA en % (ex: 20)"),
      echeance: z.string().describe("Date echeance YYYY-MM-DD"),
      description: z.string().describe("Description de la facture")
    },
    async ({ socid, montantHT, tauxTva, echeance, description }) => {
      const factureId = await doliPost("/supplierinvoices", {
        socid, date: Math.floor(Date.now() / 1000),
        date_lim_reglement: Math.floor(new Date(echeance).getTime() / 1000),
        lines: [{ desc: description || "Facture fournisseur", subprice: montantHT, qty: 1, tva_tx: tauxTva }]
      });
      return { content: [{ type: "text", text: JSON.stringify({ succes: true, facture_id: factureId }) }] };
    }
  );

  return server;
}

// --- Express + Streamable HTTP transport ---

const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use(express.json());

// Sessions actives
const sessions = new Map();

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  let transport;
  if (sessionId && sessions.has(sessionId)) {
    transport = sessions.get(sessionId);
  } else {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
      }
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    const server = createMcpServer();
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (!sessionId || !sessions.has(sessionId)) {
    return res.status(400).json({ error: "Session invalide" });
  }
  const transport = sessions.get(sessionId);
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    sessions.delete(sessionId);
  }
  res.sendStatus(200);
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "dolibarr-mcp-server", version: "1.2.0", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`MCP Dolibarr v1.2 started on port ${PORT}`);
});
