import { query, transaction } from '../../db';
import { TipPool, TipPoolMember, TipPoolStatus } from '../../db/models';
import { logger } from '../../utils/logger';
import { config } from '../../config';

export interface TipReportSummary {
  totalTips: number;
  orderCount: number;
  avgTipAmount: number;
  avgTipPercent: number;
}

export interface StaffTipReport {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  tipCount: number;
  totalTips: number;
  avgTip: number;
}

export interface DailyTipReport {
  date: string;
  totalTips: number;
  orderCount: number;
}

export interface DailyStaffTip {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  avatarUrl: string | null;
  totalTips: number;
}

export interface DailyTipReportWithStaff extends DailyTipReport {
  byStaff: DailyStaffTip[];
}

export interface TipDistributionBucket {
  range: string;
  count: number;
}

export interface HourlyTipBreakdown {
  hour: number;
  totalTips: number;
  tipCount: number;
  avgTip: number;
}

export interface TipTrendPoint {
  date: string;
  tipPercent: number;
}

export interface TopTippedOrder {
  orderNumber: string;
  tipAmount: number;
  subtotal: number;
  totalAmount: number;
  customerEmail: string | null;
  createdAt: string;
}

export interface TipReport {
  summary: TipReportSummary;
  byStaff: StaffTipReport[];
  daily: DailyTipReportWithStaff[];
  tipDistribution: TipDistributionBucket[];
  hourlyBreakdown: HourlyTipBreakdown[];
  tipTrend: TipTrendPoint[];
  topTippedOrders: TopTippedOrder[];
}

export interface TipPoolWithCreator extends TipPool {
  creator_first_name: string | null;
  creator_last_name: string | null;
}

export interface TipPoolMemberWithUser extends TipPoolMember {
  first_name: string | null;
  last_name: string | null;
  avatar_image_id: string | null;
  avatarUrl: string | null;
}

export interface TipPoolDetail extends TipPoolWithCreator {
  members: TipPoolMemberWithUser[];
}

class TipsService {
  /**
   * Get tip report for an organization within a date range
   */
  async getTipReport(
    organizationId: string,
    startDate: string,
    endDate: string
  ): Promise<TipReport> {
    // Get summary stats
    const summaryResult = await query<{
      total_tips: string;
      order_count: string;
      avg_tip: string;
      total_subtotal: string;
    }>(
      `SELECT
        COALESCE(SUM(tip_amount), 0) as total_tips,
        COUNT(*) FILTER (WHERE tip_amount > 0) as order_count,
        COALESCE(AVG(tip_amount) FILTER (WHERE tip_amount > 0), 0) as avg_tip,
        COALESCE(SUM(subtotal), 0) as total_subtotal
      FROM orders
      WHERE organization_id = $1
        AND status = 'completed'
        AND created_at >= $2::date
        AND created_at < ($3::date + interval '1 day')`,
      [organizationId, startDate, endDate]
    );

    const summary = summaryResult[0];
    const totalTips = Math.round(parseFloat(summary.total_tips) * 100) / 100;
    const orderCount = parseInt(summary.order_count) || 0;
    const avgTipAmount = Math.round((parseFloat(summary.avg_tip) || 0) * 100) / 100;
    const totalSubtotal = parseFloat(summary.total_subtotal) || 0;
    const avgTipPercent = totalSubtotal > 0
      ? Math.round((totalTips / totalSubtotal) * 100 * 100) / 100
      : 0;

    // Get tips by staff member
    const staffResult = await query<{
      user_id: string;
      first_name: string | null;
      last_name: string | null;
      avatar_image_id: string | null;
      tip_count: string;
      total_tips: string;
    }>(
      `SELECT
        o.user_id,
        u.first_name,
        u.last_name,
        u.avatar_image_id,
        COUNT(*) FILTER (WHERE o.tip_amount > 0) as tip_count,
        COALESCE(SUM(o.tip_amount), 0) as total_tips
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.organization_id = $1
        AND o.status = 'completed'
        AND o.created_at >= $2::date
        AND o.created_at < ($3::date + interval '1 day')
        AND o.user_id IS NOT NULL
      GROUP BY o.user_id, u.first_name, u.last_name, u.avatar_image_id
      ORDER BY total_tips DESC`,
      [organizationId, startDate, endDate]
    );

    const byStaff: StaffTipReport[] = staffResult.map(row => {
      const tipCount = parseInt(row.tip_count) || 0;
      const staffTotalTips = Math.round((parseFloat(row.total_tips) || 0) * 100) / 100;
      return {
        userId: row.user_id,
        firstName: row.first_name,
        lastName: row.last_name,
        avatarUrl: row.avatar_image_id && config.images.fileServerUrl
          ? `${config.images.fileServerUrl}/images/${row.avatar_image_id}`
          : null,
        tipCount,
        totalTips: staffTotalTips,
        avgTip: tipCount > 0 ? Math.round((staffTotalTips / tipCount) * 100) / 100 : 0,
      };
    });

    // Get daily breakdown
    const dailyResult = await query<{
      date: Date;
      total_tips: string;
      order_count: string;
    }>(
      `SELECT
        DATE(created_at) as date,
        COALESCE(SUM(tip_amount), 0) as total_tips,
        COUNT(*) FILTER (WHERE tip_amount > 0) as order_count
      FROM orders
      WHERE organization_id = $1
        AND status = 'completed'
        AND created_at >= $2::date
        AND created_at < ($3::date + interval '1 day')
      GROUP BY DATE(created_at)
      ORDER BY date`,
      [organizationId, startDate, endDate]
    );

    // Get daily breakdown by staff
    const dailyStaffResult = await query<{
      date: Date;
      user_id: string;
      first_name: string | null;
      last_name: string | null;
      avatar_image_id: string | null;
      total_tips: string;
    }>(
      `SELECT
        DATE(o.created_at) as date,
        o.user_id,
        u.first_name,
        u.last_name,
        u.avatar_image_id,
        COALESCE(SUM(o.tip_amount), 0) as total_tips
      FROM orders o
      LEFT JOIN users u ON o.user_id = u.id
      WHERE o.organization_id = $1
        AND o.status = 'completed'
        AND o.created_at >= $2::date
        AND o.created_at < ($3::date + interval '1 day')
        AND o.tip_amount > 0
        AND o.user_id IS NOT NULL
      GROUP BY DATE(o.created_at), o.user_id, u.first_name, u.last_name, u.avatar_image_id
      ORDER BY date, total_tips DESC`,
      [organizationId, startDate, endDate]
    );

    // Group daily staff tips by date
    const dailyStaffMap = new Map<string, DailyStaffTip[]>();
    for (const row of dailyStaffResult) {
      const dateStr = row.date.toISOString().split('T')[0];
      if (!dailyStaffMap.has(dateStr)) {
        dailyStaffMap.set(dateStr, []);
      }
      dailyStaffMap.get(dateStr)!.push({
        userId: row.user_id,
        firstName: row.first_name,
        lastName: row.last_name,
        avatarUrl: row.avatar_image_id && config.images.fileServerUrl
          ? `${config.images.fileServerUrl}/images/${row.avatar_image_id}`
          : null,
        totalTips: Math.round((parseFloat(row.total_tips) || 0) * 100) / 100,
      });
    }

    const daily: DailyTipReportWithStaff[] = dailyResult.map(row => {
      const dateStr = row.date.toISOString().split('T')[0];
      return {
        date: dateStr,
        totalTips: Math.round((parseFloat(row.total_tips) || 0) * 100) / 100,
        orderCount: parseInt(row.order_count) || 0,
        byStaff: dailyStaffMap.get(dateStr) || [],
      };
    });

    // Get tip % distribution buckets
    const distributionResult = await query<{
      range: string;
      count: string;
    }>(
      `SELECT
        CASE
          WHEN subtotal = 0 THEN 'No Subtotal'
          WHEN (tip_amount / subtotal * 100) < 10 THEN 'Under 10%'
          WHEN (tip_amount / subtotal * 100) < 15 THEN '10-14%'
          WHEN (tip_amount / subtotal * 100) < 20 THEN '15-19%'
          WHEN (tip_amount / subtotal * 100) < 25 THEN '20-24%'
          ELSE '25%+'
        END as range,
        COUNT(*) as count
      FROM orders
      WHERE organization_id = $1
        AND status = 'completed'
        AND tip_amount > 0
        AND created_at >= $2::date
        AND created_at < ($3::date + interval '1 day')
      GROUP BY range`,
      [organizationId, startDate, endDate]
    );

    const tipDistribution: TipDistributionBucket[] = distributionResult.map(row => ({
      range: row.range,
      count: parseInt(row.count) || 0,
    }));

    // Get hourly breakdown
    const hourlyResult = await query<{
      hour: string;
      total_tips: string;
      tip_count: string;
      avg_tip: string;
    }>(
      `SELECT
        EXTRACT(HOUR FROM created_at) as hour,
        COALESCE(SUM(tip_amount), 0) as total_tips,
        COUNT(*) FILTER (WHERE tip_amount > 0) as tip_count,
        COALESCE(AVG(tip_amount) FILTER (WHERE tip_amount > 0), 0) as avg_tip
      FROM orders
      WHERE organization_id = $1
        AND status = 'completed'
        AND created_at >= $2::date
        AND created_at < ($3::date + interval '1 day')
      GROUP BY hour
      ORDER BY hour`,
      [organizationId, startDate, endDate]
    );

    const hourlyBreakdown: HourlyTipBreakdown[] = hourlyResult.map(row => ({
      hour: parseInt(row.hour) || 0,
      totalTips: Math.round((parseFloat(row.total_tips) || 0) * 100) / 100,
      tipCount: parseInt(row.tip_count) || 0,
      avgTip: Math.round((parseFloat(row.avg_tip) || 0) * 100) / 100,
    }));

    // Get daily tip % trend
    const trendResult = await query<{
      date: Date;
      tip_percent: string;
    }>(
      `SELECT
        DATE(created_at) as date,
        CASE WHEN SUM(subtotal) > 0
          THEN ROUND(SUM(tip_amount) / SUM(subtotal) * 100, 1)
          ELSE 0
        END as tip_percent
      FROM orders
      WHERE organization_id = $1
        AND status = 'completed'
        AND created_at >= $2::date
        AND created_at < ($3::date + interval '1 day')
      GROUP BY DATE(created_at)
      ORDER BY date`,
      [organizationId, startDate, endDate]
    );

    const tipTrend: TipTrendPoint[] = trendResult.map(row => ({
      date: row.date.toISOString().split('T')[0],
      tipPercent: parseFloat(row.tip_percent) || 0,
    }));

    // Get top 5 tipped orders
    const topTippedResult = await query<{
      order_number: string;
      tip_amount: string;
      subtotal: string;
      total_amount: string;
      customer_email: string | null;
      created_at: Date;
    }>(
      `SELECT
        order_number, tip_amount, subtotal, total_amount, customer_email, created_at
      FROM orders
      WHERE organization_id = $1
        AND status = 'completed'
        AND tip_amount > 0
        AND created_at >= $2::date
        AND created_at < ($3::date + interval '1 day')
      ORDER BY tip_amount DESC
      LIMIT 5`,
      [organizationId, startDate, endDate]
    );

    const topTippedOrders: TopTippedOrder[] = topTippedResult.map(row => ({
      orderNumber: row.order_number,
      tipAmount: Math.round((parseFloat(row.tip_amount) || 0) * 100) / 100,
      subtotal: Math.round((parseFloat(row.subtotal) || 0) * 100) / 100,
      totalAmount: Math.round((parseFloat(row.total_amount) || 0) * 100) / 100,
      customerEmail: row.customer_email,
      createdAt: row.created_at.toISOString(),
    }));

    return {
      summary: {
        totalTips,
        orderCount,
        avgTipAmount,
        avgTipPercent,
      },
      byStaff,
      daily,
      tipDistribution,
      hourlyBreakdown,
      tipTrend,
      topTippedOrders,
    };
  }

  /**
   * List tip pools for an organization
   */
  async listPools(
    organizationId: string,
    options: { status?: TipPoolStatus; limit?: number; offset?: number } = {}
  ): Promise<{ pools: TipPoolWithCreator[]; total: number }> {
    const { status, limit = 20, offset = 0 } = options;

    let whereClause = 'WHERE tp.organization_id = $1';
    const params: any[] = [organizationId];

    if (status) {
      params.push(status);
      whereClause += ` AND tp.status = $${params.length}`;
    }

    // Get total count
    const countResult = await query<{ count: string }>(
      `SELECT COUNT(*) as count FROM tip_pools tp ${whereClause}`,
      params
    );

    // Get pools with creator info
    const poolsResult = await query<TipPoolWithCreator>(
      `SELECT
        tp.*,
        u.first_name as creator_first_name,
        u.last_name as creator_last_name
      FROM tip_pools tp
      LEFT JOIN users u ON tp.created_by = u.id
      ${whereClause}
      ORDER BY tp.created_at DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    return {
      pools: poolsResult,
      total: parseInt(countResult[0].count) || 0,
    };
  }

  /**
   * Get a single tip pool with its members
   */
  async getPool(poolId: string, organizationId: string): Promise<TipPoolDetail | null> {
    const poolResult = await query<TipPoolWithCreator>(
      `SELECT
        tp.*,
        u.first_name as creator_first_name,
        u.last_name as creator_last_name
      FROM tip_pools tp
      LEFT JOIN users u ON tp.created_by = u.id
      WHERE tp.id = $1 AND tp.organization_id = $2`,
      [poolId, organizationId]
    );

    if (poolResult.length === 0) {
      return null;
    }

    const pool = poolResult[0];

    // Get members with user info
    const membersResult = await query<TipPoolMemberWithUser>(
      `SELECT
        tpm.*,
        u.first_name,
        u.last_name,
        u.avatar_image_id
      FROM tip_pool_members tpm
      LEFT JOIN users u ON tpm.user_id = u.id
      WHERE tpm.tip_pool_id = $1
      ORDER BY tpm.pool_share DESC`,
      [poolId]
    );

    const members: TipPoolMemberWithUser[] = membersResult.map(m => ({
      ...m,
      avatarUrl: m.avatar_image_id
        ? `${config.images.fileServerUrl}/images/${m.avatar_image_id}`
        : null,
    }));

    return {
      ...pool,
      members,
    };
  }

  /**
   * Create a new tip pool
   */
  async createPool(params: {
    organizationId: string;
    name: string;
    startDate: string;
    endDate: string;
    notes?: string;
    createdBy: string;
  }): Promise<TipPool> {
    const result = await query<TipPool>(
      `INSERT INTO tip_pools (
        organization_id, name, start_date, end_date, notes, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *`,
      [
        params.organizationId,
        params.name,
        params.startDate,
        params.endDate,
        params.notes || null,
        params.createdBy,
      ]
    );

    logger.info('Created tip pool', { poolId: result[0].id, name: params.name });
    return result[0];
  }

  /**
   * Update a tip pool
   */
  async updatePool(
    poolId: string,
    organizationId: string,
    updates: { name?: string; notes?: string; status?: TipPoolStatus }
  ): Promise<TipPool | null> {
    // Check pool exists and get current status
    const existing = await query<TipPool>(
      'SELECT * FROM tip_pools WHERE id = $1 AND organization_id = $2',
      [poolId, organizationId]
    );

    if (existing.length === 0) {
      return null;
    }

    // Don't allow updates to finalized pools (except status can go back if needed)
    if (existing[0].status === 'finalized' && !updates.status) {
      throw new Error('Cannot update a finalized tip pool');
    }

    const setClauses: string[] = [];
    const params: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      params.push(updates.name);
    }
    if (updates.notes !== undefined) {
      setClauses.push(`notes = $${paramIndex++}`);
      params.push(updates.notes);
    }
    if (updates.status !== undefined) {
      setClauses.push(`status = $${paramIndex++}`);
      params.push(updates.status);
    }

    if (setClauses.length === 0) {
      return existing[0];
    }

    setClauses.push(`updated_at = NOW()`);
    params.push(poolId, organizationId);

    const result = await query<TipPool>(
      `UPDATE tip_pools SET ${setClauses.join(', ')}
       WHERE id = $${paramIndex++} AND organization_id = $${paramIndex}
       RETURNING *`,
      params
    );

    return result[0];
  }

  /**
   * Delete a tip pool (only if in draft status)
   */
  async deletePool(poolId: string, organizationId: string): Promise<boolean> {
    const result = await query(
      `DELETE FROM tip_pools
       WHERE id = $1 AND organization_id = $2 AND status = 'draft'
       RETURNING id`,
      [poolId, organizationId]
    );

    if (result.length === 0) {
      return false;
    }

    logger.info('Deleted tip pool', { poolId });
    return true;
  }

  /**
   * Add or update members in a tip pool
   */
  async setPoolMembers(
    poolId: string,
    organizationId: string,
    members: Array<{ userId: string; hoursWorked: number }>
  ): Promise<TipPoolMemberWithUser[]> {
    // Verify pool exists and is not finalized
    const pool = await query<TipPool>(
      'SELECT * FROM tip_pools WHERE id = $1 AND organization_id = $2',
      [poolId, organizationId]
    );

    if (pool.length === 0) {
      throw new Error('Tip pool not found');
    }

    if (pool[0].status === 'finalized') {
      throw new Error('Cannot modify members of a finalized tip pool');
    }

    // Only allow members that belong to this organization — otherwise a
    // caller could inject arbitrary user UUIDs and leak those users' name/
    // avatar via the pool detail (cross-org PII).
    if (members.length > 0) {
      const ids = members.map(m => m.userId);
      const valid = await query<{ id: string }>(
        'SELECT id FROM users WHERE id = ANY($1) AND organization_id = $2',
        [ids, organizationId]
      );
      const validIds = new Set(valid.map(r => r.id));
      const foreign = ids.filter(id => !validIds.has(id));
      if (foreign.length > 0) {
        throw new Error('One or more members do not belong to this organization');
      }
    }

    // Use upsert for each member
    for (const member of members) {
      await query(
        `INSERT INTO tip_pool_members (tip_pool_id, user_id, hours_worked)
         VALUES ($1, $2, $3)
         ON CONFLICT (tip_pool_id, user_id)
         DO UPDATE SET hours_worked = $3, updated_at = NOW()`,
        [poolId, member.userId, member.hoursWorked]
      );
    }

    // Reset to draft if it was calculated (since hours changed)
    if (pool[0].status === 'calculated') {
      await query(
        `UPDATE tip_pools SET status = 'draft', updated_at = NOW() WHERE id = $1`,
        [poolId]
      );
    }

    // Return updated members list
    const result = await query<TipPoolMemberWithUser>(
      `SELECT
        tpm.*,
        u.first_name,
        u.last_name,
        u.avatar_image_id
      FROM tip_pool_members tpm
      LEFT JOIN users u ON tpm.user_id = u.id
      WHERE tpm.tip_pool_id = $1
      ORDER BY tpm.hours_worked DESC`,
      [poolId]
    );

    return result.map(m => ({
      ...m,
      avatarUrl: m.avatar_image_id
        ? `${config.images.fileServerUrl}/images/${m.avatar_image_id}`
        : null,
    }));
  }

  /**
   * Remove a member from a tip pool
   */
  async removePoolMember(poolId: string, userId: string, organizationId: string): Promise<boolean> {
    const pool = await query<TipPool>(
      'SELECT * FROM tip_pools WHERE id = $1 AND organization_id = $2',
      [poolId, organizationId]
    );

    if (pool.length === 0) {
      throw new Error('Tip pool not found');
    }

    if (pool[0].status === 'finalized') {
      throw new Error('Cannot modify members of a finalized tip pool');
    }

    const result = await query(
      'DELETE FROM tip_pool_members WHERE tip_pool_id = $1 AND user_id = $2 RETURNING id',
      [poolId, userId]
    );

    return result.length > 0;
  }

  /**
   * Calculate tip distribution based on hours worked
   */
  async calculatePool(poolId: string, organizationId: string): Promise<TipPoolDetail> {
    return await transaction(async (client) => {
      // Get pool
      const poolResult = await client.query(
        'SELECT * FROM tip_pools WHERE id = $1 AND organization_id = $2',
        [poolId, organizationId]
      );

      if (poolResult.rows.length === 0) {
        throw new Error('Tip pool not found');
      }

      const pool = poolResult.rows[0] as TipPool;

      if (pool.status === 'finalized') {
        throw new Error('Cannot recalculate a finalized tip pool');
      }

      // Get total tips from orders in the date range
      const tipsResult = await client.query(
        `SELECT COALESCE(SUM(tip_amount), 0) as total_tips
         FROM orders
         WHERE organization_id = $1
           AND status = 'completed'
           AND created_at >= $2::date
           AND created_at < ($3::date + interval '1 day')`,
        [organizationId, pool.start_date, pool.end_date]
      );

      const totalTips = parseFloat(tipsResult.rows[0].total_tips) || 0;

      // Get members with their individual tips earned
      const membersResult = await client.query(
        `SELECT
          tpm.id, tpm.user_id, tpm.hours_worked,
          COALESCE(tips.earned, 0) as tips_earned
        FROM tip_pool_members tpm
        LEFT JOIN (
          SELECT user_id, SUM(tip_amount) as earned
          FROM orders
          WHERE organization_id = $1
            AND status = 'completed'
            AND created_at >= $2::date
            AND created_at < ($3::date + interval '1 day')
            AND tip_amount > 0
          GROUP BY user_id
        ) tips ON tpm.user_id = tips.user_id
        WHERE tpm.tip_pool_id = $4`,
        [organizationId, pool.start_date, pool.end_date, poolId]
      );

      const members = membersResult.rows;

      // Calculate total hours
      const totalHours = members.reduce(
        (sum: number, m: any) => sum + parseFloat(m.hours_worked || 0),
        0
      );

      if (totalHours === 0) {
        throw new Error('Total hours worked cannot be zero');
      }

      // Calculate each member's share
      let distributedAmount = 0;
      const memberUpdates: Array<{ id: string; poolShare: number; tipsEarned: number }> = [];

      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const hours = parseFloat(member.hours_worked) || 0;
        const tipsEarned = parseFloat(member.tips_earned) || 0;

        let poolShare: number;
        if (i === members.length - 1) {
          // Last member gets remainder to avoid rounding errors
          poolShare = totalTips - distributedAmount;
        } else {
          poolShare = Math.round((hours / totalHours) * totalTips);
          distributedAmount += poolShare;
        }

        memberUpdates.push({
          id: member.id,
          poolShare,
          tipsEarned,
        });
      }

      // Update all members
      for (const update of memberUpdates) {
        await client.query(
          `UPDATE tip_pool_members
           SET tips_earned = $1, pool_share = $2, final_amount = $2, updated_at = NOW()
           WHERE id = $3`,
          [update.tipsEarned, update.poolShare, update.id]
        );
      }

      // Update pool with total and status
      await client.query(
        `UPDATE tip_pools
         SET total_tips = $1, status = 'calculated', updated_at = NOW()
         WHERE id = $2`,
        [totalTips, poolId]
      );

      logger.info('Calculated tip pool', { poolId, totalTips, memberCount: members.length });

      // Return full pool detail
      return (await this.getPool(poolId, organizationId))!;
    });
  }

  /**
   * Finalize a tip pool (lock it from further changes)
   */
  async finalizePool(poolId: string, organizationId: string): Promise<TipPool> {
    const pool = await query<TipPool>(
      'SELECT * FROM tip_pools WHERE id = $1 AND organization_id = $2',
      [poolId, organizationId]
    );

    if (pool.length === 0) {
      throw new Error('Tip pool not found');
    }

    if (pool[0].status === 'draft') {
      throw new Error('Cannot finalize a pool that has not been calculated');
    }

    if (pool[0].status === 'finalized') {
      return pool[0];
    }

    const result = await query<TipPool>(
      `UPDATE tip_pools SET status = 'finalized', updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [poolId]
    );

    logger.info('Finalized tip pool', { poolId });
    return result[0];
  }

  /**
   * Get staff members who had tips in a date range (for auto-populating pool members)
   */
  async getStaffWithTips(
    organizationId: string,
    startDate: string,
    endDate: string
  ): Promise<Array<{
    userId: string;
    firstName: string | null;
    lastName: string | null;
    avatarUrl: string | null;
    totalTips: number;
  }>> {
    const result = await query<{
      user_id: string;
      first_name: string | null;
      last_name: string | null;
      avatar_image_id: string | null;
      total_tips: string;
    }>(
      `SELECT
        o.user_id,
        u.first_name,
        u.last_name,
        u.avatar_image_id,
        COALESCE(SUM(o.tip_amount), 0) as total_tips
      FROM orders o
      JOIN users u ON o.user_id = u.id
      WHERE o.organization_id = $1
        AND o.status = 'completed'
        AND o.created_at >= $2::date
        AND o.created_at < ($3::date + interval '1 day')
        AND o.user_id IS NOT NULL
      GROUP BY o.user_id, u.first_name, u.last_name, u.avatar_image_id
      HAVING SUM(o.tip_amount) > 0
      ORDER BY total_tips DESC`,
      [organizationId, startDate, endDate]
    );

    return result.map(row => ({
      userId: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      avatarUrl: row.avatar_image_id
        ? `${config.images.fileServerUrl}/images/${row.avatar_image_id}`
        : null,
      totalTips: parseFloat(row.total_tips) || 0,
    }));
  }
}

export const tipsService = new TipsService();
