export default async function handler(req: any, res: any) {
  try {
    const srcValue = req?.query?.src;
    const source = Array.isArray(srcValue) ? srcValue[0] : srcValue;
    if (!source || typeof source !== 'string') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Missing src query parameter' }));
      return;
    }

    let remoteUrl: URL;
    try {
      remoteUrl = new URL(source);
    } catch {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid src URL' }));
      return;
    }

    if (remoteUrl.protocol !== 'http:' && remoteUrl.protocol !== 'https:') {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Only http/https URLs are allowed' }));
      return;
    }

    const upstream = await fetch(remoteUrl.toString(), {
      redirect: 'follow',
      headers: {
        Accept: 'image/*,*/*;q=0.8',
        'User-Agent': 'courtsight-avatar-proxy',
      },
    });

    if (!upstream.ok) {
      res.statusCode = upstream.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Upstream request failed (${upstream.status})` }));
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';

    res.statusCode = 200;
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(body.length));
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(body);
  } catch {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Avatar proxy error' }));
  }
}
