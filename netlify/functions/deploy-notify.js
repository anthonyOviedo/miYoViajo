// Triggered by Netlify deploy events via the Netlify UI webhook:
// Site settings → Build & deploy → Deploy notifications → Outgoing webhooks
// Point the "Deploy succeeded" and "Deploy failed" events to this function URL.

export async function handler(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const webhookUrl = process.env.DISCORD_WH;
  if (!webhookUrl) {
    return { statusCode: 500, body: 'DISCORD_WH not configured' };
  }

  const state = payload.state || 'unknown';
  const deployUrl = payload.deploy_ssl_url || payload.url || 'https://miyoviajo.netlify.app';
  const branch = payload.branch || 'main';
  const commitRef = (payload.commit_ref || '').substring(0, 7);
  const commitMsg = payload.title || 'Sin mensaje';
  const buildTime = payload.deploy_time ? `${payload.deploy_time}s` : '—';

  const isSuccess = state === 'ready';
  const color = isSuccess ? 3066993 : 15158332; // green / red
  const emoji = isSuccess ? '✅' : '❌';
  const title = isSuccess
    ? '🚌 MiYoViajo — Deploy exitoso'
    : '🚌 MiYoViajo — Deploy fallido';

  const body = {
    embeds: [{
      title,
      description: isSuccess
        ? `La app está en vivo: [Abrir](${deployUrl})`
        : 'El deploy falló. Revisa los logs en Netlify.',
      color,
      fields: [
        { name: `${emoji} Estado`, value: state, inline: true },
        { name: '⏱ Tiempo', value: buildTime, inline: true },
        { name: '🌿 Rama', value: `\`${branch}\``, inline: true },
        ...(commitRef ? [{ name: '📝 Commit', value: `\`${commitRef}\` ${commitMsg}`, inline: false }] : []),
        ...(isSuccess ? [{ name: '🔗 URL', value: deployUrl, inline: false }] : []),
      ],
      footer: { text: 'Netlify Deploy' },
      timestamp: new Date().toISOString(),
    }],
  };

  await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  return { statusCode: 200, body: 'OK' };
}
