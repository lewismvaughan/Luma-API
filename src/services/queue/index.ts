import { Queue, Worker, QueueEvents, Job } from 'bullmq';
import { config } from '../../config';
import { logger } from '../../utils/logger';

const connection = {
  host: config.bull.redis.host,
  port: config.bull.redis.port,
};

export enum QueueName {
  PAYMENT_PROCESSING = 'payment-processing',
  EMAIL_NOTIFICATIONS = 'email-notifications',
  PAYOUT_PROCESSING = 'payout-processing',
}

export interface JobData {
  [QueueName.PAYMENT_PROCESSING]: {
    orderId: string;
    paymentIntentId: string;
    amount: number;
  };
  [QueueName.EMAIL_NOTIFICATIONS]: {
    type: 'order_confirmation' | 'receipt' | 'payout_confirmation' | 'welcome' | 'ticket_confirmation' | 'ticket_reminder' | 'ticket_refund' | 'preorder_confirmation' | 'preorder_ready' | 'preorder_cancelled' | 'invoice_sent' | 'invoice_paid' | 'invoice_payment_failed' | 'invoice_refunded' | 'dispute_created';
    to: string;
    data: Record<string, any>;
    vendorBranding?: { organizationName: string; brandingLogoUrl: string | null };
    currency?: string;
  };
  [QueueName.PAYOUT_PROCESSING]: {
    eventId: string;
    userId?: string;
    amount: number;
    type: 'tip_out' | 'revenue_split';
  };
}

export class QueueService {
  private queues: Map<QueueName, Queue> = new Map();
  private workers: Map<QueueName, Worker> = new Map();
  private queueEvents: Map<QueueName, QueueEvents> = new Map();

  constructor() {
    Object.values(QueueName).forEach((queueName) => {
      const queue = new Queue(queueName, { connection });
      const queueEvents = new QueueEvents(queueName, { connection });
      
      this.queues.set(queueName, queue);
      this.queueEvents.set(queueName, queueEvents);

      queueEvents.on('completed', ({ jobId, returnvalue }) => {
        logger.info(`Job completed`, { queue: queueName, jobId, returnvalue });
      });

      queueEvents.on('failed', ({ jobId, failedReason }) => {
        logger.error(`Job failed`, { queue: queueName, jobId, failedReason });
      });
    });
  }

  async addJob<T extends QueueName>(
    queueName: T,
    data: JobData[T],
    options?: {
      delay?: number;
      priority?: number;
      attempts?: number;
      backoff?: {
        type: 'exponential' | 'fixed';
        delay: number;
      };
    }
  ): Promise<Job<JobData[T]>> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const job = await queue.add(queueName, data, {
      // Bound retention so Redis doesn't grow unboundedly with completed/failed
      // jobs. Failed jobs are kept long enough to investigate (14d, 5k cap).
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 14 * 24 * 3600, count: 5000 },
      attempts: options?.attempts || 3,
      backoff: options?.backoff || {
        type: 'exponential',
        delay: 2000,
      },
      ...options,
    });

    logger.info(`Job added to queue`, {
      queue: queueName,
      jobId: job.id,
      data,
    });

    return job;
  }

  async getJob(queueName: QueueName, jobId: string): Promise<Job | undefined> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    return await queue.getJob(jobId);
  }

  async getJobs(
    queueName: QueueName,
    status: 'completed' | 'waiting' | 'active' | 'delayed' | 'failed',
    start = 0,
    end = 20
  ): Promise<Job[]> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    return await queue.getJobs([status], start, end);
  }

  async pauseQueue(queueName: QueueName): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    await queue.pause();
    logger.info(`Queue paused`, { queue: queueName });
  }

  async resumeQueue(queueName: QueueName): Promise<void> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    await queue.resume();
    logger.info(`Queue resumed`, { queue: queueName });
  }

  async cleanQueue(
    queueName: QueueName,
    grace: number,
    limit: number,
    status: 'completed' | 'failed'
  ): Promise<string[]> {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const jobs = await queue.clean(grace, limit, status);
    logger.info(`Queue cleaned`, {
      queue: queueName,
      removedCount: jobs.length,
      status,
    });

    return jobs;
  }

  async getQueueMetrics(queueName: QueueName) {
    const queue = this.queues.get(queueName);
    if (!queue) {
      throw new Error(`Queue ${queueName} not found`);
    }

    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
      queue.getDelayedCount(),
    ]);

    return {
      waiting,
      active,
      completed,
      failed,
      delayed,
      total: waiting + active + completed + failed + delayed,
    };
  }

  registerWorker<T extends QueueName>(
    queueName: T,
    processor: (job: Job<JobData[T]>) => Promise<any>
  ): Worker<JobData[T]> {
    const worker = new Worker<JobData[T]>(
      queueName,
      processor,
      {
        connection,
        concurrency: 5,
        autorun: true,
      }
    );

    worker.on('completed', (job) => {
      logger.debug(`Worker completed job`, {
        queue: queueName,
        jobId: job.id,
      });
    });

    worker.on('failed', (job, err) => {
      logger.error(`Worker failed job`, {
        queue: queueName,
        jobId: job?.id,
        error: err.message,
      });
    });

    this.workers.set(queueName, worker);
    return worker;
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      ...Array.from(this.queues.values()).map((queue) => queue.close()),
      ...Array.from(this.workers.values()).map((worker) => worker.close()),
      ...Array.from(this.queueEvents.values()).map((events) => events.close()),
    ]);
  }
}

export const queueService = new QueueService();