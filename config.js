// Public runtime config for the Remo site. Nothing secret lives here: the Supabase key
// is the publishable (anon) key — the same one baked into the mobile app — and every
// write goes through the rate-limited submit_web_request() RPC (migration 0057).
window.REMO_CONFIG = {
  supabaseUrl: 'https://rtztjvphbregxfclzivz.supabase.co',
  supabaseKey: 'sb_publishable_YS1OvcNZPG2AMC5fWNqcIw_NWRtxD6Q',
  // WhatsApp number for the «Написать в WhatsApp» buttons, digits only with country code.
  // TODO(founder): replace with the real Remo number (docs/FOUNDER-TODO.md).
  whatsapp: '996000000000',
  supportEmail: 'support@remo.kg',
  // Storage bucket for the photos attached to a request (private, anon insert only).
  photoBucket: 'web-requests',
  maxPhotos: 3,
};
