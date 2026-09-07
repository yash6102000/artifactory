const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
const Fastify = require('fastify');
const view = require('@fastify/view');
const multipart = require('@fastify/multipart');
const formbody = require('@fastify/formbody');
const ejs = require('ejs');
const db = require('./db');
const munkiRepo = require('./munki-repo');
const { isWhitelisted } = require('./ip-whitelist');

const PORT = process.env.PORT || 3100;
const HOST = process.env.HOST || '127.0.0.1';

munkiRepo.ensureRepoScaffold();

const app = Fastify({ logger: true, trustProxy: true });

app.register(view, {
  engine: { ejs },
  root: path.join(__dirname, '..', 'views'),
});
app.register(formbody);
app.register(multipart, {
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

if (process.env.FORCE_HTTPS === '1') {
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers['x-forwarded-proto'] === 'https') return;
    app.log.warn(`blocked plain-http request to ${req.raw.url}`);
    reply.code(403).send('Forbidden: HTTPS required.');
  });
}

app.addHook('onRequest', async (req, reply) => {
  if (!req.raw.url.startsWith('/admin')) return;
  if (isWhitelisted(req.ip)) return;
  app.log.warn(`blocked admin access from ${req.ip}`);
  reply.code(403).send('Forbidden: this IP is not whitelisted for admin access.');
});

app.get('/admin/packages', async (_req, reply) => {
  const packages = munkiRepo.listPackages();
  return reply.view('packages.ejs', { packages });
});

app.get('/admin/packages/new', async (_req, reply) => {
  return reply.view('package-new.ejs', {});
});

app.post('/admin/packages', async (req, reply) => {
  const fields = {};
  let tmpFilePath = null;

  // The upload form always declares enctype="multipart/form-data", but
  // external-mode submissions carry no file — accept plain urlencoded
  // bodies too rather than forcing every request through the multipart
  // parser (which throws on a non-multipart content-type).
  if (req.isMultipart()) {
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === 'file') {
        if (!part.filename) continue;
        const ext = path.extname(part.filename) || '.pkg';
        tmpFilePath = path.join(os.tmpdir(), `upload-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
        const writeStream = fs.createWriteStream(tmpFilePath);
        for await (const chunk of part.file) writeStream.write(chunk);
        await new Promise((resolve, reject) => {
          writeStream.end((err) => (err ? reject(err) : resolve()));
        });
      } else {
        fields[part.fieldname] = part.value;
      }
    }
  } else {
    Object.assign(fields, req.body || {});
  }

  const requires = fields.requires
    ? fields.requires.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  if (fields.mode === 'external') {
    if (!fields.name || !fields.version || !fields.source_url || !fields.sha256 || !fields.size_bytes) {
      return reply.code(400).send({ error: 'name, version, source_url, sha256, and size_bytes are required for external packages' });
    }
    munkiRepo.importExternal({
      name: fields.name,
      displayName: fields.display_name,
      version: fields.version,
      category: fields.category,
      description: fields.description,
      developer: fields.developer,
      sourceUrl: fields.source_url,
      sha256: fields.sha256,
      sizeBytes: fields.size_bytes,
      requires,
    });
  } else {
    if (!tmpFilePath || !fields.name || !fields.version) {
      if (tmpFilePath) fs.unlinkSync(tmpFilePath);
      return reply.code(400).send({ error: 'name, version, and a file are required' });
    }
    munkiRepo.importFile({
      filePath: tmpFilePath,
      name: fields.name,
      displayName: fields.display_name,
      version: fields.version,
      category: fields.category,
      description: fields.description,
      developer: fields.developer,
      requires,
    });
    fs.unlinkSync(tmpFilePath);
  }

  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/approve', async (req, reply) => {
  munkiRepo.approve(req.params.id);
  return reply.redirect('/admin/packages');
});

app.post('/admin/packages/:id/revoke', async (req, reply) => {
  munkiRepo.revoke(req.params.id);
  return reply.redirect('/admin/packages');
});

app.listen({ port: PORT, host: HOST }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Munki catalog server listening at ${address}`);
});

module.exports = app;
