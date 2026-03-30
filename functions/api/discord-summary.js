/**
 * Cloudflare Pages Function — POST /api/discord-summary
 *
 * Receives a pre-formatted Discord message body from the browser and
 * forwards it to the Discord webhook using the server-side secret.
 * The DISCORD_WEBHOOK env var is never sent to the browser.
 *
 * Expected request body (JSON): { content: string }
 */
export async function onRequestPost(context) {
  const webhookUrl = context.env.DISCORD_WEBHOOK;
  if (!webhookUrl) {
    return new Response('DISCORD_WEBHOOK not configured', { status: 500 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!body || typeof body.content !== 'string') {
    return new Response('Missing content field', { status: 400 });
  }

  const discordRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: body.content }),
  });

  if (!discordRes.ok) {
    return new Response('Discord error', { status: 502 });
  }

  return new Response('OK', { status: 200 });
}
