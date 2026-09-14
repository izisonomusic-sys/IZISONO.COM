import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import billingRoutes from './routes/billing.js';
import lyricsRoutes from './routes/lyrics.js';
import languageRoutes from './routes/language.js';
import musicRoutes, { recoverPendingGenerations } from './routes/music.js';
import adminRoutes from './routes/admin.js';
import { CURRENCY_CONFIG, SUPPORTED_LANGUAGES } from '../izisono-config/i18n.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const AUDIO_DIR = path.join(__dirname, 'audio');
const FRONTEND_DIR = path.join(__dirname, 'public');
const LEGACY_FRONTEND_DIR = path.join(__dirname, '..', 'izisono-frontend');
const allowedOrigins = new Set(String(process.env.CLIENT_URL || 'http://localhost:3000').split(',').map(x=>x.trim()).filter(Boolean));

// Configuration CORS pour les langues du Togo
app.use(cors({
  origin: (origin, cb) => { if (!origin || allowedOrigins.has(origin)) return cb(null, true); cb(new Error('cors_origin_not_allowed')); },
  credentials: true,
  optionsSuccessStatus: 200,
}));

// Middleware pour détecter la langue et la monnaie
app.use((req, res, next) => {
  const browserLang = req.acceptsLanguages(Object.keys(SUPPORTED_LANGUAGES));
  req.language = req.query.lang || req.headers['accept-language']?.split(',')[0]?.split('-')[0] || browserLang || 'fr';
  req.currency = CURRENCY_CONFIG;
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Public runtime configuration must be registered before the generic /api routers.
app.get('/api/config', (req, res) => {
  res.set('Cache-Control','no-store');
  res.json({
    app: 'izisono',
    supabase: { url: process.env.SUPABASE_URL || '', publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || '' },
    version: '1.1.0',
    languages: SUPPORTED_LANGUAGES,
    currency: {
      code: CURRENCY_CONFIG.code,
      symbol: CURRENCY_CONFIG.symbol,
      name: CURRENCY_CONFIG.name,
      paymentCode: CURRENCY_CONFIG.payment_code || 'XOF',
    },
    features: {
      multilingual: true,
      localCurrency: true,
      aiGeneration: true,
      communityGallery: true,
    }
  });
});

// Routes API
app.use('/api', musicRoutes);
app.use('/api', lyricsRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/language', languageRoutes);
app.use('/api/admin', adminRoutes);

// Fichiers audio générés
app.use('/audio', express.static(AUDIO_DIR));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', app: 'izisono' });
});

function frontendPath(fileName) {
  return path.join(FRONTEND_DIR, fileName);
}

async function resolveFrontendFile(fileName) {
  const candidates = [frontendPath(fileName), path.join(LEGACY_FRONTEND_DIR, fileName)];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {}
  }
  return null;
}

app.get('/admin', async (_req, res) => {
  const file = await resolveFrontendFile('admin.html');
  if (!file) return res.status(500).type('text/plain').send('frontend_unavailable');
  res.sendFile(file);
});

// Serve the browser module from the self-contained server/public directory.
// The legacy frontend directory remains as a fallback for local development.
app.get('/script.js', async (_req, res) => {
  try {
    const file = await resolveFrontendFile('script.js');
    if (!file) throw new Error('frontend_script_not_found');
    let source = await fs.readFile(file, 'utf8');

    // The original frontend loaded Supabase directly from third-party CDNs. In
    // production this can be blocked by CSP, privacy extensions, corporate
    // filters, or transient CDN failures. Keep the frontend unchanged while
    // making its Supabase import same-origin and therefore much more reliable.
    const loader = `\nasync function loadSupabaseClient(){\n  if(window.supabase?.createClient)return window.supabase.createClient;\n  await new Promise((resolve,reject)=>{\n    const s=document.createElement('script');\n    s.src='/supabase-client.js';\n    s.async=true;\n    s.onload=()=>resolve();\n    s.onerror=()=>reject(new Error('Impossible de charger le module Supabase depuis le serveur.'));\n    document.head.appendChild(s);\n  });\n  if(!window.supabase?.createClient)throw new Error('Le module Supabase est indisponible.');\n  return window.supabase.createClient;\n}\n`;
    source = source.replace('async function bootSupabase(){', loader + 'async function bootSupabase(){');
    source = source.replace("  let createClient;\n  try{\n    ({createClient}=await import('https://esm.sh/@supabase/supabase-js@2'));\n  }catch(first){\n    console.warn('Supabase CDN esm.sh indisponible, tentative jsDelivr',first);\n    try{\n      ({createClient}=await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'));\n    }catch(second){\n      throw new Error('Impossible de charger le module Supabase. Vérifie ta connexion ou désactive le bloqueur de contenu.');\n    }\n  }", "  const createClient=await loadSupabaseClient();");

    res.set({
      'Content-Type': 'application/javascript; charset=UTF-8',
      'Cache-Control': 'no-store'
    });
    res.status(200).send(source);
  } catch (error) {
    console.error('Failed to serve frontend script:', error);
    res.status(500).type('text/plain').send('frontend_script_unavailable');
  }
});

// Proxy the browser UMD build through the same Render origin. This avoids
// browser-side cross-origin/module loading failures while keeping the SDK
// public (it contains no Supabase secret; only the publishable key is used).
let supabaseClientSdkCache = null;
let supabaseClientSdkPromise = null;
app.get('/supabase-client.js', async (_req, res) => {
  try {
    if (!supabaseClientSdkCache) {
      if (!supabaseClientSdkPromise) {
        supabaseClientSdkPromise = fetch('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js')
          .then(async r => {
            if (!r.ok) throw new Error(`Supabase SDK HTTP ${r.status}`);
            return r.text();
          })
          .then(source => {
            if (!source.includes('createClient')) throw new Error('Supabase SDK invalide');
            supabaseClientSdkCache = source;
            return source;
          })
          .finally(() => { supabaseClientSdkPromise = null; });
      }
      await supabaseClientSdkPromise;
    }
    res.set({
      'Content-Type': 'application/javascript; charset=UTF-8',
      'Cache-Control': 'public, max-age=3600'
    });
    res.status(200).send(supabaseClientSdkCache);
  } catch (error) {
    console.error('Failed to proxy Supabase browser SDK:', error);
    res.status(502).type('text/plain').send('supabase_client_unavailable');
  }
});

// Frontend statique
app.use(express.static(FRONTEND_DIR, { fallthrough: true }));
app.use(express.static(LEGACY_FRONTEND_DIR, { fallthrough: true }));

// SPA fallback
app.get('*', async (_req, res) => {
  const file = await resolveFrontendFile('index.html');
  if (!file) return res.status(500).type('text/plain').send('frontend_unavailable');
  res.sendFile(file);
});

const port = process.env.PORT || 3000;
app.listen(port, async () => {
  console.log(`🎵 izisono backend prêt sur http://localhost:${port}`);
  console.log(`📍 Localisation: Togo (Francophone)`);
  console.log(`💱 Monnaie affichée: ${CURRENCY_CONFIG.name} (${CURRENCY_CONFIG.code}) · Paiement PayDunya: ${CURRENCY_CONFIG.payment_code || 'XOF'}`);
  console.log(`🌍 Langues: ${Object.keys(SUPPORTED_LANGUAGES).join(', ')}`);
  console.log(`🤖 Fournisseur: ${process.env.MUSIC_PROVIDER || 'mureka'}`);
  await recoverPendingGenerations();
  setInterval(() => recoverPendingGenerations().catch(()=>{}), 5 * 60 * 1000);
});
