// Netlify runs this automatically after every verified Netlify Forms submission.
// It copies waitlist signups into Brevo and credits whoever referred them.
// Nothing is emailed from here: Brevo only sends if a double-opt-in template is
// configured (BREVO_DOI_TEMPLATE_ID) or an automation is switched on in Brevo.

const API = "https://api.brevo.com/v3";

async function brevo(path, method, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Brevo ${method} ${path} -> ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

// Referral codes are short lowercase slugs like "paul482"; keep anything else out.
const cleanCode = (c) => (String(c || "").toLowerCase().match(/^[a-z0-9]{2,40}$/) || [""])[0];

// Classic handler signature: the one Netlify documents for event-triggered functions.
export const handler = async (event) => {
  const done = (msg) => {
    console.log("submission-created:", msg);
    return { statusCode: 200, body: msg };
  };
  let payload;
  try {
    payload = JSON.parse(event.body || "{}").payload;
  } catch (err) {
    return done("could not parse body: " + err.message);
  }
  if (!payload) return done("no payload");
  if (payload.form_name !== "waitlist") return done("ignored form " + payload.form_name);
  if (!process.env.BREVO_API_KEY) return done("BREVO_API_KEY missing: signup kept in Netlify Forms only");

  const d = payload.data || {};
  const email = String(d.email || "").trim().toLowerCase();
  if (!email) return done("no email in submission");

  const attributes = {
    FIRSTNAME: String(d.name || "").trim().split(/\s+/)[0] || "",
    VARIANT: String(d.variant || ""),
    REF_CODE: cleanCode(d.mycode),
    REFERRED_BY: cleanCode(d.ref),
    SIGNUP_SOURCE: "waitlist-site",
  };
  const listId = Number(process.env.BREVO_LIST_ID);

  try {
    if (process.env.BREVO_DOI_TEMPLATE_ID) {
      // Double opt-in: Brevo emails a confirm link and only adds them to the list once clicked.
      await brevo("/contacts/doubleOptinConfirmation", "POST", {
        email,
        attributes,
        includeListIds: [listId],
        templateId: Number(process.env.BREVO_DOI_TEMPLATE_ID),
        redirectionUrl: process.env.BREVO_DOI_REDIRECT || "https://buybyphone.co.uk/?confirmed=1",
      });
    } else {
      await brevo("/contacts", "POST", {
        email,
        attributes,
        listIds: listId ? [listId] : undefined,
        updateEnabled: true,
      });
    }
  } catch (err) {
    // The signup is still safe in Netlify Forms; log and stop.
    return done("brevo error: " + err.message);
  }
  console.log("submission-created: added to Brevo", email);

  // Credit the referrer (best effort: a failure here never loses the signup).
  if (attributes.REFERRED_BY && attributes.REFERRED_BY !== attributes.REF_CODE) {
    try {
      const filter = encodeURIComponent(`equals(REF_CODE,"${attributes.REFERRED_BY}")`);
      const found = await brevo(`/contacts?limit=1&filter=${filter}`, "GET");
      const referrer = found && found.contacts && found.contacts[0];
      if (referrer) {
        const count = Number((referrer.attributes || {}).REFERRAL_COUNT || 0) + 1;
        await brevo(`/contacts/${encodeURIComponent(referrer.email)}`, "PUT", {
          attributes: { REFERRAL_COUNT: count },
        });
      }
    } catch (err) {
      console.error("referral credit failed:", err.message);
    }
  }

  return done("ok");
};
