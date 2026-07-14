require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3000;

// ---- META (Keystone's own ad account) ----
const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v25.0';
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const AD_ACCOUNT_ID = process.env.META_AD_ACCOUNT_ID; // act_XXXXXXXXXX
const META_PAGE_ID = process.env.META_PAGE_ID;

// ---- APIFY (competitor ad intelligence) ----
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR_SLUG = process.env.APIFY_ACTOR_SLUG || 'harvestlab/facebook-ads-library-scraper';
const APIFY_ACTOR_PATH = APIFY_ACTOR_SLUG.replace('/', '~');

// ---- ANTHROPIC (creative generation) ----
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const THRESHOLDS = {
  minImpressions: Number(process.env.MIN_IMPRESSIONS || 1000),
  ctrGood: Number(process.env.CTR_GOOD || 1.0),
  costPerLeadMax: Number(process.env.COST_PER_LEAD_MAX || 40)
};

const SERVICES = [
  'commercial cleaning', 'office cleaning', 'property maintenance',
  'window washing', 'pressure washing'
];

const DB_PATH = path.join(__dirname, 'data.json');
function loadDB() {
  if (!fs.existsSync(DB_PATH)) return { drafts: [], lastSync: null, adSnapshot: [], competitorCache: {} };
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { return { drafts: [], lastSync: null, adSnapshot: [], competitorCache: {} }; }
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }
let db = loadDB();

function detectService(adName = '') {
  const n = adName.toLowerCase();
  if (n.includes('window')) return 'window washing';
  if (n.includes('pressure') || n.includes('power wash')) return 'pressure washing';
  if (n.includes('office')) return 'office cleaning';
  if (n.includes('maintenance') || n.includes('property')) return 'property maintenance';
  return 'commercial cleaning';
}
function extractAction(actions, type) {
  if (!actions) return 0;
  const match = actions.find(a => a.action_type === type);
  return match ? Number(match.value) : 0;
}
function extractCostPer(costPerActionType, type) {
  if (!costPerActionType) return null;
  const match = costPerActionType.find(a => a.action_type === type);
  return match ? Number(match.value) : null;
}
function daysSince(dateStr) {
  if (!dateStr) return null;
  const start = new Date(dateStr).getTime();
  if (isNaN(start)) return null;
  return Math.floor((Date.now() - start) / 86400000);
}

// ---- KEYSTONE'S OWN AD PERFORMANCE ----

async function fetchAdInsights() {
  if (!META_TOKEN || !AD_ACCOUNT_ID) throw new Error('META_ACCESS_TOKEN / META_AD_ACCOUNT_ID not configured');
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/insights`;
  const fields = ['ad_id', 'ad_name', 'spend', 'impressions', 'clicks', 'ctr', 'actions', 'cost_per_action_type'].join(',');
  const resp = await axios.get(url, {
    params: { level: 'ad', fields, date_preset: 'last_7d', access_token: META_TOKEN, limit: 200 }
  });
  return resp.data.data || [];
}

function classifyAds(rawAds) {
  return rawAds.map(ad => {
    const impressions = Number(ad.impressions || 0);
    const clicks = Number(ad.clicks || 0);
    const ctr = Number(ad.ctr || 0);
    const spend = Number(ad.spend || 0);
    const leads = extractAction(ad.actions, 'lead') || extractAction(ad.actions, 'onsite_conversion.lead_grouped');
    const messages = extractAction(ad.actions, 'onsite_conversion.messaging_conversation_started_7d');
    const costPerLead = extractCostPer(ad.cost_per_action_type, 'lead') || (leads > 0 ? spend / leads : null);
    const conversionRate = clicks > 0 ? ((leads / clicks) * 100) : 0;
    let status = 'gathering_data';
    if (impressions >= THRESHOLDS.minImpressions) {
      const healthyCtr = ctr >= THRESHOLDS.ctrGood;
      const healthyCost = costPerLead === null ? true : costPerLead <= THRESHOLDS.costPerLeadMax;
      status = (healthyCtr && healthyCost) ? 'winning' : 'needs_fixing';
    }
    return {
      adId: ad.ad_id, adName: ad.ad_name, service: detectService(ad.ad_name),
      spend, impressions, clicks, ctr, leads, messages,
      costPerLead: costPerLead !== null ? Number(costPerLead.toFixed(2)) : null,
      conversionRate: Number(conversionRate.toFixed(2)), status
    };
  });
}

// ---- COMPETITOR AD INTELLIGENCE (Apify) ----

async function fetchCompetitorAds(query, opts = {}) {
  if (!APIFY_TOKEN) return [];
  const url = `https://api.apify.com/v2/acts/${APIFY_ACTOR_PATH}/run-sync-get-dataset-items?token=${APIFY_TOKEN}`;
  const input = {
    searchQuery: query, q: query,
    country: opts.country || 'US',
    activeStatus: opts.activeStatus || 'active',
    maxResults: opts.maxResults || 30
  };
  const resp = await axios.post(url, input, { timeout: 120000 });
  return resp.data || [];
}

function scoreCompetitorAds(rawAds) {
  return rawAds.map(ad => {
    const daysRunning = daysSince(ad.adDeliveryStartTime || ad.ad_delivery_start_time);
    const isActive = ad.isActive !== undefined ? ad.isActive : ad.is_active;
    const impressionsLower = Number((ad.impressions && (ad.impressions.lower_bound || ad.impressions.lowerBound)) || 0);
    let score = 0;
    if (daysRunning !== null) score += Math.min(daysRunning, 90);
    if (isActive) score += 20;
    if (impressionsLower >= 100000) score += 30; else if (impressionsLower >= 10000) score += 15;
    return {
      pageName: ad.pageName || ad.page_name,
      body: ad.adCreativeBody || (ad.ad_creative_bodies && ad.ad_creative_bodies[0]) || '',
      linkTitle: ad.adCreativeLinkTitle || (ad.ad_creative_link_titles && ad.ad_creative_link_titles[0]) || '',
      daysRunning, isActive: !!isActive, score,
      likelyWinner: daysRunning !== null && daysRunning >= 30 && isActive
    };
  }).sort((a, b) => b.score - a.score);
}

async function getCompetitorAdsForService(service, forceRefresh = false) {
  const cacheKey = `keystone cleaning ${service}`;
  const cached = db.competitorCache[cacheKey];
  const CACHE_TTL_MS = 24 * 3600 * 1000;
  if (!forceRefresh && cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_MS) return cached.ads;
  try {
    const raw = await fetchCompetitorAds(`${service} Philadelphia`, { country: 'US', maxResults: 30 });
    const scored = scoreCompetitorAds(raw);
    db.competitorCache[cacheKey] = { ads: scored, fetchedAt: Date.now() };
    saveDB(db);
    return scored;
  } catch (err) {
    console.error(`Competitor fetch failed for ${service}:`, err.message);
    return cached ? cached.ads : [];
  }
}

// ---- CREATIVE GENERATION (informed by competitor winners) ----

async function generateCreativesWithClaude(ad, competitorAds) {
  const topCompetitors = competitorAds.filter(c => c.likelyWinner).slice(0, 3);
  const competitorContext = topCompetitors.length
    ? topCompetitors.map((c, i) => `${i + 1}. ${c.pageName} (running ${c.daysRunning} days, still active — likely a winner): angle summary — "${(c.body || '').slice(0, 150)}"`).join('\n')
    : 'No competitor winner data available yet for this service.';

  const prompt = `You are a direct-response ad copywriter for Keystone Cleaners Group, a commercial cleaning company in Philadelphia PA (NAICS 561720).

An ad for their "${ad.service}" service is underperforming:
- Impressions: ${ad.impressions}, CTR: ${ad.ctr}%, Cost per lead: ${ad.costPerLead !== null ? '$' + ad.costPerLead : 'no leads yet'}, Conversion rate: ${ad.conversionRate}%

Here are ads currently running long-term (30+ days, still active) from other advertisers in this niche — evidence they're working for someone:
${competitorContext}

Study the STRUCTURE and ANGLE these winners use (pain point, proof, urgency, offer framing) — do NOT copy their wording. Write 3 original ad creative concepts for Keystone that apply similar winning structural principles to Keystone's own voice and offer.

Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{"creatives":[{"primaryText":"...","headline":"...","description":"...","cta":"LEARN_MORE or GET_QUOTE or MESSAGE_US","imagePrompt":"...","suggestedAudience":"...","suggestedDailyBudget":"$X/day","reason":"...","inspiredBy":"which competitor pattern this borrows structurally, in your own words"}]}

Keep primaryText under 125 words. Philadelphia-focused, B2B tone, no fluff.`;

  const resp = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-5',
    max_tokens: 1800,
    messages: [{ role: 'user', content: prompt }]
  }, {
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
  });
  const text = resp.data.content.map(b => b.text || '').join('');
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean).creatives;
}

function fallbackTemplateCreatives(ad, competitorAds) {
  const s = ad.service;
  const hasCompetitorData = competitorAds.some(c => c.likelyWinner);
  return [1, 2, 3].map(i => ({
    primaryText: `Keystone Cleaners Group keeps Philadelphia businesses spotless with reliable ${s}. Variant ${i} — no long-term contract, licensed & insured crew, flexible scheduling around your hours.`,
    headline: `${s.charAt(0).toUpperCase() + s.slice(1)} in Philadelphia`,
    description: `Get a free quote for ${s} — usually same week.`,
    cta: i === 1 ? 'GET_QUOTE' : (i === 2 ? 'MESSAGE_US' : 'LEARN_MORE'),
    imagePrompt: `Photo-real image of a clean, well-lit Philadelphia commercial space mid-${s}, professional crew, daylight, no text overlay`,
    suggestedAudience: 'Business owners and office managers, Philadelphia metro, 30-60',
    suggestedDailyBudget: '$25/day',
    reason: `Template fallback (no ANTHROPIC_API_KEY set) — variant ${i} rotates the CTA/angle to test against the underperforming ad's baseline.`,
    inspiredBy: hasCompetitorData ? 'Competitor data was available but requires Claude to interpret — add ANTHROPIC_API_KEY to use it.' : 'No competitor winner data cached yet for this service.'
  }));
}

async function generateDraftsForAd(ad) {
  const competitorAds = await getCompetitorAdsForService(ad.service);
  let creatives;
  try {
    creatives = ANTHROPIC_API_KEY ? await generateCreativesWithClaude(ad, competitorAds) : fallbackTemplateCreatives(ad, competitorAds);
  } catch (err) {
    console.error('Claude generation failed, using fallback:', err.message);
    creatives = fallbackTemplateCreatives(ad, competitorAds);
  }
  const now = new Date().toISOString();
  return creatives.map((c, idx) => ({
    id: `${ad.adId}-${Date.now()}-${idx}`,
    sourceAdId: ad.adId, sourceAdName: ad.adName, service: ad.service,
    status: 'pending', createdAt: now,
    targetAdSetId: process.env.DEFAULT_AD_SET_ID || '',
    imageBase64: null,
    ...c
  }));
}

// ---- META AD CREATION (on approve) ----

async function createPausedAdInMeta(draft) {
  if (!META_TOKEN || !AD_ACCOUNT_ID) throw new Error('Meta credentials not configured');
  if (!draft.targetAdSetId) throw new Error('targetAdSetId required — set it before approving');

  let imageHash = null;
  if (draft.imageBase64) {
    const imgResp = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/adimages`,
      { bytes: draft.imageBase64 }, { params: { access_token: META_TOKEN } });
    const images = imgResp.data.images || {};
    const firstKey = Object.keys(images)[0];
    imageHash = firstKey ? images[firstKey].hash : null;
  }

  const creativeResp = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/adcreatives`, {
    name: `${draft.sourceAdName} - regenerated - ${draft.id}`,
    object_story_spec: {
      page_id: META_PAGE_ID,
      link_data: {
        message: draft.primaryText, name: draft.headline, description: draft.description,
        call_to_action: { type: draft.cta, value: { link: process.env.LANDING_PAGE_URL || 'https://keystonecleanerspa.com' } },
        ...(imageHash ? { image_hash: imageHash } : {})
      }
    }
  }, { params: { access_token: META_TOKEN } });
  const creativeId = creativeResp.data.id;

  const adResp = await axios.post(`https://graph.facebook.com/${GRAPH_VERSION}/${AD_ACCOUNT_ID}/ads`, {
    name: `${draft.headline} (auto-draft, PAUSED)`,
    adset_id: draft.targetAdSetId,
    creative: { creative_id: creativeId },
    status: 'PAUSED'
  }, { params: { access_token: META_TOKEN } });
  return { creativeId, adId: adResp.data.id };
}

// ---- ROUTES ----

app.get('/api/health', (req, res) => res.json({ ok: true, lastSync: db.lastSync }));

app.get('/api/ads/winning', (req, res) => res.json(db.adSnapshot.filter(a => a.status === 'winning')));
app.get('/api/ads/needs-fixing', (req, res) => res.json(db.adSnapshot.filter(a => a.status === 'needs_fixing')));
app.get('/api/drafts', (req, res) => {
  const { status } = req.query;
  res.json(status ? db.drafts.filter(d => d.status === status) : db.drafts);
});

// Competitor intel tab
app.get('/api/competitor-ads', async (req, res) => {
  const service = req.query.service || 'commercial cleaning';
  const force = req.query.refresh === 'true';
  try {
    const ads = await getCompetitorAdsForService(service, force);
    res.json({ service, ads });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  try { res.json(await runDailySync()); }
  catch (err) { res.status(502).json({ error: err.message }); }
});

app.put('/api/drafts/:id', (req, res) => {
  const draft = db.drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  Object.assign(draft, req.body);
  saveDB(db);
  res.json(draft);
});
app.post('/api/drafts/:id/reject', (req, res) => {
  const draft = db.drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  draft.status = 'rejected';
  saveDB(db);
  res.json(draft);
});
app.post('/api/drafts/:id/approve', async (req, res) => {
  const draft = db.drafts.find(d => d.id === req.params.id);
  if (!draft) return res.status(404).json({ error: 'draft not found' });
  try {
    const result = await createPausedAdInMeta(draft);
    draft.status = 'approved'; draft.metaAdId = result.adId; draft.metaCreativeId = result.creativeId;
    saveDB(db);
    res.json({ draft, meta: result, note: 'Ad created in Meta Ads Manager as PAUSED. Activate it manually when ready.' });
  } catch (err) {
    console.error(err.response ? err.response.data : err.message);
    res.status(502).json({ error: 'Meta ad creation failed', detail: err.response ? err.response.data : err.message });
  }
});

// ---- DAILY SYNC ----

async function runDailySync() {
  const results = { keystoneSynced: 0, needsFixing: 0, newDrafts: 0, competitorRefreshed: [] };
  if (META_TOKEN && AD_ACCOUNT_ID) {
    const raw = await fetchAdInsights();
    const classified = classifyAds(raw);
    db.adSnapshot = classified;
    db.lastSync = new Date().toISOString();
    results.keystoneSynced = classified.length;

    const needsFixing = classified.filter(a => a.status === 'needs_fixing');
    results.needsFixing = needsFixing.length;
    for (const ad of needsFixing) {
      const alreadyPending = db.drafts.some(d => d.sourceAdId === ad.adId && d.status === 'pending');
      if (alreadyPending) continue;
      const newDrafts = await generateDraftsForAd(ad);
      db.drafts.push(...newDrafts);
      results.newDrafts += newDrafts.length;
    }
  }
  if (APIFY_TOKEN) {
    for (const service of SERVICES) {
      await getCompetitorAdsForService(service, true);
      results.competitorRefreshed.push(service);
    }
  }
  saveDB(db);
  return results;
}

cron.schedule('0 7 * * *', () => { runDailySync().catch(err => console.error('Daily sync failed:', err.message)); });

app.listen(PORT, () => {
  console.log(`Keystone Growth Engine running on port ${PORT}`);
  console.log(`Meta configured: ${!!(META_TOKEN && AD_ACCOUNT_ID)} | Apify configured: ${!!APIFY_TOKEN} | Claude configured: ${!!ANTHROPIC_API_KEY}`);
  runDailySync().catch(err => console.error('Initial sync failed:', err.message));
});
