// ============================================================
//  MCP Server — Dolibarr
//  Assistant IA Vincent × Claude
//  Version 1.0 — 2026-03-23
// ============================================================

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

// ── Configuration ────────────────────────────────────────────
const DOLIBARR_BASE = "https://nicolasclimatisation.with10.dolicloud.com/api/index.php/v1";
const DOLIBARR_API_KEY = process.env.DOLIBARR_API_KEY;
const PORT = process.env.PORT || 3000;

if (!DOLIBARR_API_KEY) {
  console.error("[ERREUR] Variable d'environnement DOLIBARR_API_KEY manquante.");
  process.exit(1);
}

// ── Client HTTP Dolibarr ─────────────────────────────────────

const doliHeaders = {
  "DOLAPIKEY": DOLIBARR_API_KEY,
  "Content-Type": "application/json",
  "Accept": "application/json"
};

async function doliGet(path) {
  const res = await fetch(`${DOLIBARR_BASE}${path}`, { headers: doliHeaders });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dolibarr GET ${path} → HTTP ${res.status} : ${body}`);
  }
  return res.json();
}

async function doliPost(path, body) {
  const res = await fetch(`${DOLIBARR_BASE}${path}`, {
    method: "POST",
    headers: doliHeaders,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Dolibarr POST ${path} → HTTP ${res.status} : ${body}`);
  }
  return res.json();
}

// ── Serveur MCP ───────────────────────────────────────────────

const server = new McpServer({
  name: "dolibarr-vincent",
  version: "1.0.0"
});

// ────────────────────────────────────────────────────────────
//  OUTIL 1 — Factures clients impayées
// ────────────────────────────────────────────────────────────
server.tool(
  "get_factures_impayees",
  "Récupère toutes les factures clients impayées, triées par échéance. Utilisé pour le résumé quotidien et les alertes de retard.",
  {},
  async () => {
    const data = await doliGet(
      "/invoices?status=unpaid&sortfield=t.date_lim_reglement&sortorder=ASC&limit=20"
    );

    const factures = (Array.isArray(data) ? data : []).map(f => ({
      id: f.id,
      ref: f.ref,
      client: f.socnom,
      socid: f.socid,
      montant_ttc: parseFloat(f.total_ttc || 0),
      echeance: f.date_lim_reglement
        ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0]
        : null,
      retard_jours: f.date_lim_reglement
        ? Math.floor((Date.now() - f.date_lim_reglement * 1000) / 86_400_000)
        : 0,
      statut: f.statut_libelle || ""
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ factures, total: factures.length })
      }]
    };
  }
);

// ────────────────────────────────────────────────────────────
//  OUTIL 2 — Factures fournisseurs en attente
// ────────────────────────────────────────────────────────────
server.tool(
  "get_factures_fournisseurs_en_attente",
  "Récupère les factures fournisseurs non payées (status=0), triées par échéance. Utilisé pour les alertes de paiement fournisseurs.",
  {},
  async () => {
    const data = await doliGet(
      "/supplierinvoices?status=0&sortfield=t.date_lim_reglement&sortorder=ASC&limit=20"
    );

    const factures = (Array.isArray(data) ? data : []).map(f => ({
      id: f.id,
      ref: f.ref,
      fournisseur: f.socnom,
      montant_ttc: parseFloat(f.total_ttc || 0),
      echeance: f.date_lim_reglement
        ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0]
        : null
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ factures, total: factures.length })
      }]
    };
  }
);

// ────────────────────────────────────────────────────────────
//  OUTIL 3 — Factures d'un client (panneau client)
// ────────────────────────────────────────────────────────────
server.tool(
  "get_factures_client",
  "Récupère les 10 dernières factures d'un client Dolibarr. Utilisé pour alimenter le panneau client.",
  { socid: z.string().describe("Identifiant numérique du tiers dans Dolibarr (socid)") },
  async ({ socid }) => {
    const data = await doliGet(
      `/invoices?thirdparty_ids=${socid}&sortfield=t.rowid&sortorder=DESC&limit=10`
    );

    const factures = (Array.isArray(data) ? data : []).map(f => ({
      id: f.id,
      ref: f.ref,
      montant_ttc: parseFloat(f.total_ttc || 0),
      date: f.date ? new Date(f.date * 1000).toISOString().split("T")[0] : null,
      echeance: f.date_lim_reglement
        ? new Date(f.date_lim_reglement * 1000).toISOString().split("T")[0]
        : null,
      statut: f.statut,
      statut_libelle: f.statut_libelle || ""
    }));

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ factures, total: factures.length })
      }]
    };
  }
);

// ────────────────────────────────────────────────────────────
//  OUTIL 4 — Recherche tiers par email
// ────────────────────────────────────────────────────────────
server.tool(
  "find_thirdparty_by_email",
  "Cherche un tiers Dolibarr (client ou fournisseur) par adresse email. Retourne null si non trouvé.",
  { email: z.string().describe("Adresse email à rechercher") },
  async ({ email }) => {
    const data = await doliGet(
      `/thirdparties?email=${encodeURIComponent(email)}&limit=1`
    );

    const tiers = Array.isArray(data) && data.length > 0 ? {
      id: data[0].id,
      nom: data[0].name,
      email: data[0].email,
      telephone: data[0].phone,
      adresse: data[0].address,
      code_client: data[0].code_client
    } : null;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ tiers })
      }]
    };
  }
);

// ────────────────────────────────────────────────────────────
//  OUTIL 5 — Fiche complète d'un tiers
// ────────────────────────────────────────────────────────────
server.tool(
  "get_thirdparty",
  "Récupère la fiche complète d'un tiers Dolibarr (client ou fournisseur) par son identifiant.",
  { socid: z.string().describe("Identifiant numérique du tiers (socid)") },
  async ({ socid }) => {
    const data = await doliGet(`/thirdparties/${socid}`);

    const tiers = data ? {
      id: data.id,
      nom: data.name,
      email: data.email,
      telephone: data.phone,
      adresse: data.address,
      code_postal: data.zip,
      ville: data.town,
      code_client: data.code_client,
      url_dolibarr: `https://nicolasclimatisation.with10.dolicloud.com/societe/card.php?socid=${data.id}`
    } : null;

    return {
      content: [{
        type: "text",
        text: JSON.stringify({ tiers })
      }]
    };
  }
);

// ────────────────────────────────────────────────────────────
//  OUTIL 6 — Créer une facture depuis un devis Dolibarr
//  ⚠ Écriture — appelé uniquement après validation Vincent
// ────────────────────────────────────────────────────────────
server.tool(
  "create_facture_from_devis",
  "Crée et valide une facture Dolibarr depuis un devis existant. ÉCRITURE — appeler uniquement après validation explicite de Vincent.",
  {
    proposalId: z.string().describe("Identifiant du devis Dolibarr (fk_proposal)"),
    socid: z.string().describe("Identifiant du client (socid)")
  },
  async ({ proposalId, socid }) => {
    // 1. Récupérer le devis
    const proposal = await doliGet(`/proposals/${proposalId}`);
    if (!proposal) throw new Error(`Devis Dolibarr ${proposalId} introuvable`);

    // 2. Créer la facture
    const factureId = await doliPost("/invoices", {
      socid: socid,
      fk_proposal: proposalId,
      date: Math.floor(Date.now() / 1000),
      cond_reglement_id: proposal.cond_reglement_id || 1,
      lines: proposal.lines || []
    });

    if (!factureId) throw new Error("Création facture échouée — Dolibarr n'a pas retourné d'ID");

    // 3. Valider la facture
    await doliPost(`/invoices/${factureId}/validate`, { notrigger: 0 });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          succes: true,
          facture_id: factureId,
          message: `Facture ${factureId} créée et validée depuis devis ${proposalId}`
        })
      }]
    };
  }
);

// ────────────────────────────────────────────────────────────
//  OUTIL 7 — Créer une facture fournisseur
//  ⚠ Écriture — appelé uniquement après validation Vincent
// ────────────────────────────────────────────────────────────
server.tool(
  "create_facture_fournisseur",
  "Crée une facture fournisseur dans Dolibarr depuis les données extraites d'un email PDF. ÉCRITURE — appeler uniquement après validation explicite de Vincent.",
  {
    socid: z.string().describe("Identifiant du fournisseur (socid)"),
    montantHT: z.number().describe("Montant hors taxes en euros"),
    tauxTva: z.number().describe("Taux de TVA en pourcentage (ex: 20)"),
    echeance: z.string().describe("Date d'échéance au format YYYY-MM-DD"),
    description: z.string().describe("Description ou libellé de la facture fournisseur")
  },
  async ({ socid, montantHT, tauxTva, echeance, description }) => {
    const factureId = await doliPost("/supplierinvoices", {
      socid: socid,
      date: Math.floor(Date.now() / 1000),
      date_lim_reglement: Math.floor(new Date(echeance).getTime() / 1000),
      lines: [
        {
          desc: description || "Facture fournisseur",
          subprice: montantHT,
          qty: 1,
          tva_tx: tauxTva
        }
      ]
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          succes: true,
          facture_id: factureId,
          message: `Facture fournisseur ${factureId} créée dans Dolibarr`
        })
      }]
    };
  }
);

// ── Serveur Express + transport SSE ─────────────────────────

const app = express();
app.use(express.json());

// Stockage des transports actifs (une entrée par connexion Claude.ai)
const transports = new Map();

// Point de connexion SSE — Claude.ai se connecte ici
app.get("/sse", async (req, res) => {
  console.log(`[SSE] Nouvelle connexion : ${new Date().toISOString()}`);

  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  res.on("close", () => {
    console.log(`[SSE] Connexion fermée : ${transport.sessionId}`);
    transports.delete(transport.sessionId);
  });

  await server.connect(transport);
});

// Point de réception des messages MCP
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports.get(sessionId);

  if (!transport) {
    console.warn(`[Messages] Session inconnue : ${sessionId}`);
    return res.status(404).json({ error: "Session introuvable" });
  }

  await transport.handlePostMessage(req, res);
});

// Route de santé — Railway l'utilise pour les health checks
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "dolibarr-mcp-server",
    version: "1.0.0",
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`✅ MCP Dolibarr démarré sur le port ${PORT}`);
  console.log(`   SSE    : http://localhost:${PORT}/sse`);
  console.log(`   Santé  : http://localhost:${PORT}/health`);
});
