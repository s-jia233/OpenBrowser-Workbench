import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WorkbenchService, taskInput, taskRecoveryInput, taskMetadataInput } from './service.js';
import { browserConnectionStatus } from '../server/sse-hub.js';
import { CollaborationService } from '../collaboration/service.js';
import { roundInput, feedbackInput, retryInput, implementationInput } from '../collaboration/protocol.js';

const assets: Record<string, { name: string; type: string }> = {
  '/': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/workbench.css': { name: 'workbench.css', type: 'text/css; charset=utf-8' },
  '/workbench.js': { name: 'workbench.js', type: 'text/javascript; charset=utf-8' },
  '/ai-status.js': { name: 'ai-status.js', type: 'text/javascript; charset=utf-8' },
  '/composer-controls.js': { name: 'composer-controls.js', type: 'text/javascript; charset=utf-8' },
  '/browser-targets.js': { name: 'browser-targets.js', type: 'text/javascript; charset=utf-8' },
  '/task-drafts.js': { name: 'task-drafts.js', type: 'text/javascript; charset=utf-8' },
  '/conversation-menu.js': { name: 'conversation-menu.js', type: 'text/javascript; charset=utf-8' },
  '/collaboration.js': { name: 'collaboration.js', type: 'text/javascript; charset=utf-8' },
  '/collaboration-report.js': { name: 'collaboration-report.js', type: 'text/javascript; charset=utf-8' },
  '/collaboration-drafts.js': { name: 'collaboration-drafts.js', type: 'text/javascript; charset=utf-8' },
  '/execution-status.js': { name: 'execution-status.js', type: 'text/javascript; charset=utf-8' },
  '/favicon.svg': { name: 'favicon.svg', type: 'image/svg+xml' },
};

export async function registerWorkbench(app: FastifyInstance, root: string): Promise<void> {
  const service = new WorkbenchService(root);
  await service.initialize();
  const token = crypto.randomBytes(32).toString('hex');
  service.start();
  const collaboration = new CollaborationService(service);
  app.addHook('onClose', async () => { await collaboration.close(); await service.close(); });

  for (const [url, asset] of Object.entries(assets)) {
    app.get(url, async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      return reply.type(asset.type).send(await fs.readFile(new URL(`../../web/${asset.name}`, import.meta.url)));
    });
  }

  await app.register(async (api) => {
    api.addHook('onSend', async () => { await service.flush(); });
    api.addHook('preHandler', async (request, reply) => {
      const host = request.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
        return reply.code(403).send({ error: '工作台仅允许本机访问' });
      }
      if (request.headers.origin && request.headers.origin !== `http://${host}`) {
        return reply.code(403).send({ error: '工作台接口只接受同源请求' });
      }
      if (request.headers['sec-fetch-site'] === 'cross-site') return reply.code(403).send({ error: '跨站请求已拒绝' });
      if (!request.url.split('?')[0].endsWith('/bootstrap') && request.headers['x-workbench-token'] !== token) {
        return reply.code(401).send({ error: '工作台连接已失效，请刷新页面' });
      }
    });
    api.setErrorHandler((error, _request, reply) => {
      const message = error instanceof z.ZodError ? error.issues.map((item) => item.message).join('；') : error.message;
      reply.code(error.statusCode && error.statusCode >= 400 ? error.statusCode : 400).send({ error: message });
    });
    api.get('/bootstrap', async () => ({ token, protocolVersion: 4, workspace: await service.workspace() }));
    api.get('/workspace', async () => service.workspace());
    api.get('/connection', async () => browserConnectionStatus());
    api.get('/collaboration/endpoints', async () => collaboration.endpoints());
    api.get('/collaboration/rounds', async () => collaboration.list());
    api.post('/collaboration/rounds', async (request) => collaboration.create(roundInput.parse(request.body)));
    api.get('/collaboration/rounds/:id', async (request) => collaboration.detail((request.params as { id: string }).id));
    api.get('/collaboration/rounds/:id/implementation-preview/:jobId', async (request) => {
      const { id, jobId } = request.params as { id: string; jobId: string };
      return collaboration.implementationPreview(id, jobId);
    });
    api.post('/collaboration/rounds/:id/implement/:jobId', async (request) => {
      const { id, jobId } = request.params as { id: string; jobId: string };
      return collaboration.implement(id, jobId, implementationInput.parse(request.body));
    });
    api.post('/collaboration/rounds/:id/replies/:jobId', async (request) => {
      const { id, jobId } = request.params as { id: string; jobId: string };
      return collaboration.accept(id, jobId, z.object({ text: z.string().trim().min(1).max(16000) }).parse(request.body).text);
    });
    api.post('/collaboration/rounds/:id/feedback', async (request) => collaboration.feedback((request.params as { id: string }).id, feedbackInput.parse(request.body)));
    api.post('/collaboration/rounds/:id/retry/:jobId', async (request) => {
      const { id, jobId } = request.params as { id: string; jobId: string };
      return collaboration.retry(id, jobId, retryInput.parse(request.body));
    });
    api.post('/collaboration/rounds/:id/cancel', async (request) => collaboration.cancel((request.params as { id: string }).id));
    api.delete('/collaboration/rounds/:id', async (request) => collaboration.remove((request.params as { id: string }).id));
    api.get('/folders', async (request) => {
      const { path: folder } = z.object({ path: z.string().min(1).max(2048).optional() }).parse(request.query);
      return service.folders(folder);
    });
    api.post('/project', async (request) => {
      const { root: nextRoot } = z.object({ root: z.string().trim().min(1).max(2048) }).parse(request.body);
      return service.selectProject(nextRoot);
    });
    api.get('/file', async (request) => {
      const { path } = z.object({ path: z.string().min(1).max(1024) }).parse(request.query);
      return service.readFile(path);
    });
    api.get('/tasks', async () => [...service.tasks.values()].reverse().map((task) => ({
      id: task.id, title: task.title, mode: task.mode, status: task.status, createdAt: task.createdAt, root: task.root,
      pinned: Boolean(task.pinned), archived: Boolean(task.archived),
    })));
    api.post('/tasks', async (request) => service.create(taskInput.parse(request.body)));
    api.post('/tasks/recover', async (request) => service.recoverTask(taskRecoveryInput.parse(request.body)));
    api.get('/tasks/:id', async (request) => service.get((request.params as { id: string }).id));
    api.delete('/tasks/:id', async (request) => service.deleteTask((request.params as { id: string }).id));
    api.patch('/tasks/:id', async (request) => service.updateTaskMetadata((request.params as { id: string }).id, taskMetadataInput.parse(request.body)));
    api.post('/tasks/:id/follow-up', async (request) => service.followUp((request.params as { id: string }).id, taskInput.parse(request.body)));
    api.post('/tasks/:id/response', async (request) => {
      const { text } = z.object({ text: z.string().trim().min(1).max(700_000) }).parse(request.body);
      return service.acceptResponse((request.params as { id: string }).id, text);
    });
    api.post('/tasks/:id/apply', async (request) => service.apply((request.params as { id: string }).id));
    api.post('/tasks/:id/cancel', async (request) => service.cancel((request.params as { id: string }).id));
    api.get('/history', async () => service.history());
  }, { prefix: '/api/ui' });
}
