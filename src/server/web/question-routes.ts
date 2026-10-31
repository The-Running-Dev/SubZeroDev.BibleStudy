import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DeletePostResponse, QuestionView, ReplyView } from '../../shared/api.ts';
import type { PostTarget, QuestionDeps } from '../questions/questions.ts';
import { deletePost, editPost, listQuestions, parseFilter, postQuestion, postReply } from '../questions/questions.ts';
import type { RealtimeHub } from '../study/realtime.ts';
import type { AppDeps } from './app.ts';
import { requireAuth } from './auth.ts';

type Params = Record<string, string>;

export function registerQuestionRoutes(app: FastifyInstance, deps: AppDeps, hub: RealtimeHub): void {
  const questions: QuestionDeps = { db: deps.db, clock: deps.clock };

  // Whoever is in the group's study sees the change as it happens; everyone else sees it on their next list. The change
  // is already committed, so a failure here is logged rather than reported as a failed post.
  async function announce(groupId: string, question: QuestionView): Promise<void> {
    try {
      const active = await deps.db.query<{ id: string }>(`SELECT id FROM study_sessions WHERE group_id = $1 AND status = 'active'`, [groupId]);
      for (const { id } of active.rows) hub.broadcast(id, { t: 'question', question });
    } catch (error) {
      app.log.warn({ err: error, questionId: question.id }, 'question change not announced');
    }
  }

  app.get('/api/groups/:groupId/questions', async (request): Promise<QuestionView[]> => {
    const { groupId } = request.params as Params;
    const userId = requireAuth(request).userId;
    return listQuestions(questions, userId, groupId, parseFilter(request.query as Record<string, unknown>));
  });

  app.post('/api/groups/:groupId/questions', async (request): Promise<QuestionView> => {
    const { groupId } = request.params as Params;
    const question = await postQuestion(questions, requireAuth(request).userId, groupId, request.body);
    await announce(groupId, question);
    return question;
  });

  app.post('/api/groups/:groupId/questions/:questionId/replies', async (request): Promise<ReplyView> => {
    const { groupId, questionId } = request.params as Params;
    const { reply, question } = await postReply(questions, requireAuth(request).userId, groupId, questionId, request.body);
    await announce(groupId, question);
    return reply;
  });

  const edit = (target: (p: Params) => PostTarget) => async (request: FastifyRequest) => {
    const params = request.params as Params;
    const { post, question } = await editPost(questions, requireAuth(request).userId, params.groupId, target(params), request.body);
    await announce(params.groupId, question);
    return post;
  };
  const remove = (target: (p: Params) => PostTarget) => async (request: FastifyRequest): Promise<DeletePostResponse> => {
    const params = request.params as Params;
    const { outcome, question } = await deletePost(questions, requireAuth(request).userId, params.groupId, target(params));
    await announce(params.groupId, question);
    return { outcome };
  };

  app.patch('/api/groups/:groupId/questions/:questionId', edit((p) => ({ questionId: p.questionId })));
  app.delete('/api/groups/:groupId/questions/:questionId', remove((p) => ({ questionId: p.questionId })));
  app.patch('/api/groups/:groupId/replies/:replyId', edit((p) => ({ replyId: p.replyId })));
  app.delete('/api/groups/:groupId/replies/:replyId', remove((p) => ({ replyId: p.replyId })));
}
