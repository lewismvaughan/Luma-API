import Stripe from 'stripe';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { toSmallestUnit, fromSmallestUnit } from '../../utils/currency';

export const stripe = new Stripe(config.stripe.secretKey);

export interface CreatePaymentIntentParams {
  amount: number;
  currency?: string;
  customer?: string;
  description?: string;
  metadata?: Record<string, string>;
  transfer_data?: {
    destination: string;
    amount?: number;
  };
}

export interface CreateConnectedAccountParams {
  type?: 'express' | 'standard' | 'custom';
  country?: string;
  email: string;
  business_type?: 'individual' | 'company';
  capabilities?: {
    card_payments?: { requested: boolean };
    transfers?: { requested: boolean };
  };
  metadata?: Record<string, string>;
}

export class StripeService {
  async createPaymentIntent(params: CreatePaymentIntentParams) {
    try {
      const paymentIntent = await stripe.paymentIntents.create({
        amount: toSmallestUnit(params.amount, params.currency || 'usd'),
        currency: params.currency || 'usd',
        customer: params.customer,
        description: params.description,
        metadata: params.metadata,
        transfer_data: params.transfer_data,
        automatic_payment_methods: {
          enabled: true,
        },
      });

      logger.info('Payment intent created', {
        paymentIntentId: paymentIntent.id,
        amount: params.amount,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to create payment intent', error);
      throw error;
    }
  }

  async confirmPaymentIntent(paymentIntentId: string, paymentMethodId?: string) {
    try {
      const paymentIntent = await stripe.paymentIntents.confirm(paymentIntentId, {
        payment_method: paymentMethodId,
      });

      logger.info('Payment intent confirmed', {
        paymentIntentId: paymentIntent.id,
        status: paymentIntent.status,
      });

      return paymentIntent;
    } catch (error) {
      logger.error('Failed to confirm payment intent', error);
      throw error;
    }
  }

  async createRefund(chargeId: string, amount?: number, reason?: string, currency: string = 'usd') {
    try {
      const refund = await stripe.refunds.create({
        charge: chargeId,
        amount: amount ? toSmallestUnit(amount, currency) : undefined,
        reason: reason as Stripe.RefundCreateParams.Reason,
      });

      logger.info('Refund created', {
        refundId: refund.id,
        chargeId,
        amount: fromSmallestUnit(refund.amount, currency),
      });

      return refund;
    } catch (error) {
      logger.error('Failed to create refund', error);
      throw error;
    }
  }

  async createConnectedAccount(params: CreateConnectedAccountParams) {
    try {
      const accountType = params.type || 'standard';

      const createParams: Stripe.AccountCreateParams = {
        type: accountType,
        country: params.country || 'US',
        email: params.email,
        business_type: params.business_type,
        metadata: params.metadata,
      };

      // Standard accounts manage their own capabilities and payout schedule via
      // their own Stripe dashboard — the platform cannot set these and Stripe
      // rejects the request if we try. Only request capabilities / control the
      // payout schedule for express & custom accounts.
      if (accountType !== 'standard') {
        createParams.capabilities = params.capabilities || {
          card_payments: { requested: true },
          transfers: { requested: true },
        };
        createParams.settings = {
          payouts: {
            schedule: {
              interval: 'manual',
            },
          },
        };
      }

      const account = await stripe.accounts.create(createParams);

      logger.info('Connected account created', {
        accountId: account.id,
        email: params.email,
      });

      return account;
    } catch (error) {
      logger.error('Failed to create connected account', error);
      throw error;
    }
  }

  async createAccountLink(
    accountId: string,
    refreshUrl: string,
    returnUrl: string,
    type: 'account_onboarding' | 'account_update' = 'account_onboarding'
  ) {
    try {
      const accountLink = await stripe.accountLinks.create({
        account: accountId,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type,
      });

      logger.info('Account link created', { accountId, type });

      return accountLink;
    } catch (error) {
      logger.error('Failed to create account link', error);
      throw error;
    }
  }

  async retrieveAccount(accountId: string) {
    try {
      const account = await stripe.accounts.retrieve(accountId);
      return account;
    } catch (error) {
      logger.error('Failed to retrieve account', error);
      throw error;
    }
  }

  async createCheckoutSession(params: {
    customer: string;
    price?: string;
    successUrl: string;
    cancelUrl: string;
    metadata?: Record<string, string>;
    mode?: 'payment' | 'subscription';
    trialPeriodDays?: number;
    couponId?: string;
  }) {
    try {
      const session = await stripe.checkout.sessions.create({
        customer: params.customer,
        line_items: params.price ? [
          {
            price: params.price,
            quantity: 1,
          },
        ] : undefined,
        mode: params.mode || 'subscription',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        metadata: params.metadata,
        billing_address_collection: 'required',
        // Add trial period for subscriptions
        subscription_data: params.mode === 'subscription' && params.trialPeriodDays ? {
          trial_period_days: params.trialPeriodDays,
        } : undefined,
        // Can't use both allow_promotion_codes and discounts - Stripe doesn't allow it
        // If we have a coupon, use discounts; otherwise allow promo codes
        ...(params.couponId
          ? { discounts: [{ coupon: params.couponId }] }
          : { allow_promotion_codes: true }),
      });
      
      logger.info('Checkout session created', { 
        sessionId: session.id,
        customer: params.customer 
      });
      
      return session;
    } catch (error) {
      logger.error('Failed to create checkout session', error);
      throw error;
    }
  }

  async createTransfer(params: {
    amount: number;
    currency?: string;
    destination: string;
    description?: string;
    metadata?: Record<string, string>;
  }) {
    try {
      const transfer = await stripe.transfers.create({
        amount: toSmallestUnit(params.amount, params.currency || 'usd'),
        currency: params.currency || 'usd',
        destination: params.destination,
        description: params.description,
        metadata: params.metadata,
      });

      logger.info('Transfer created', {
        transferId: transfer.id,
        amount: params.amount,
        destination: params.destination,
      });

      return transfer;
    } catch (error) {
      logger.error('Failed to create transfer', error);
      throw error;
    }
  }

  async createPayout(params: {
    amount: number;
    currency?: string;
    destination?: string;
    description?: string;
    metadata?: Record<string, string>;
    stripeAccount?: string;
  }) {
    try {
      const payout = await stripe.payouts.create({
        amount: toSmallestUnit(params.amount, params.currency || 'usd'),
        currency: params.currency || 'usd',
        destination: params.destination,
        description: params.description,
        metadata: params.metadata,
      }, {
        stripeAccount: params.stripeAccount,
      });

      logger.info('Payout created', {
        payoutId: payout.id,
        amount: params.amount,
      });

      return payout;
    } catch (error) {
      logger.error('Failed to create payout', error);
      throw error;
    }
  }

  async createCustomer(params: {
    email?: string;
    phone?: string;
    name?: string;
    description?: string;
    metadata?: Record<string, string>;
  }) {
    try {
      const customer = await stripe.customers.create(params);

      logger.info('Customer created', {
        customerId: customer.id,
        email: customer.email,
      });

      return customer;
    } catch (error) {
      logger.error('Failed to create customer', error);
      throw error;
    }
  }

  async attachPaymentMethod(paymentMethodId: string, customerId: string) {
    try {
      const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerId,
      });

      logger.info('Payment method attached', {
        paymentMethodId,
        customerId,
      });

      return paymentMethod;
    } catch (error) {
      logger.error('Failed to attach payment method', error);
      throw error;
    }
  }

  async createSetupIntent(params: {
    customer: string;
    payment_method_types?: string[];
    metadata?: Record<string, string>;
    usage?: 'on_session' | 'off_session';
  }) {
    try {
      const setupIntent = await stripe.setupIntents.create({
        customer: params.customer,
        payment_method_types: params.payment_method_types || ['card'],
        metadata: params.metadata,
        usage: params.usage || 'off_session',
      });

      logger.info('Setup intent created', {
        setupIntentId: setupIntent.id,
        customer: params.customer,
      });

      return setupIntent;
    } catch (error) {
      logger.error('Failed to create setup intent', error);
      throw error;
    }
  }

  constructWebhookEvent(payload: string | Buffer, signature: string, secret: string) {
    try {
      return stripe.webhooks.constructEvent(payload, signature, secret);
    } catch (error) {
      logger.error('Failed to construct webhook event', error);
      throw error;
    }
  }

  async createSubscription(params: {
    customer: string;
    items: Array<{ price: string; quantity?: number }>;
    payment_behavior?: 'default_incomplete' | 'error_if_incomplete' | 'allow_incomplete' | 'pending_if_incomplete';
    payment_settings?: {
      payment_method_types?: string[];
      save_default_payment_method?: 'on_subscription' | 'off_session';
    };
    expand?: string[];
    metadata?: Record<string, string>;
    trial_period_days?: number;
    trial_end?: number;
  }) {
    try {
      // For subscriptions requiring immediate payment, we use default_incomplete
      // which creates the subscription in incomplete status with an open invoice
      const subscription = await stripe.subscriptions.create({
        customer: params.customer,
        items: params.items,
        payment_behavior: params.payment_behavior || 'default_incomplete',
        payment_settings: (params.payment_settings || {
          save_default_payment_method: 'on_subscription',
        }) as Stripe.SubscriptionCreateParams.PaymentSettings,
        expand: params.expand || ['latest_invoice.payment_intent', 'pending_setup_intent'],
        metadata: params.metadata,
        trial_period_days: params.trial_period_days,
      });

      logger.info('Subscription created', {
        subscriptionId: subscription.id,
        customer: params.customer,
        status: subscription.status,
        hasLatestInvoice: !!subscription.latest_invoice,
        latestInvoiceType: typeof subscription.latest_invoice,
        hasPaymentIntent: subscription.latest_invoice && 
          typeof subscription.latest_invoice !== 'string' && 
          !!(subscription.latest_invoice as any).payment_intent,
        hasPendingSetupIntent: !!subscription.pending_setup_intent,
        pendingSetupIntentType: typeof subscription.pending_setup_intent,
      });

      // Log the actual structure
      if (subscription.latest_invoice && typeof subscription.latest_invoice !== 'string') {
        const invoice = subscription.latest_invoice as any;
        logger.info('Latest invoice details', {
          invoiceId: invoice.id,
          status: invoice.status,
          payment_intent: invoice.payment_intent,
          hasPaymentIntent: !!invoice.payment_intent,
        });
      }

      // Log pending_setup_intent details
      logger.info('Pending setup intent details', {
        pending_setup_intent: subscription.pending_setup_intent,
        pending_setup_intent_type: typeof subscription.pending_setup_intent,
        is_string: typeof subscription.pending_setup_intent === 'string',
      });

      return subscription;
    } catch (error) {
      logger.error('Failed to create subscription', error);
      throw error;
    }
  }

  async getSubscriptionPaymentIntent(subscriptionId: string): Promise<string | null> {
    try {
      // According to Stripe docs, when using default_incomplete, the payment intent
      // is automatically created and attached to the invoice
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice.payment_intent']
      });

      logger.info('Retrieved subscription', {
        subscriptionId,
        status: subscription.status,
        hasLatestInvoice: !!subscription.latest_invoice
      });

      if (!subscription.latest_invoice || typeof subscription.latest_invoice === 'string') {
        logger.error('No expanded latest invoice found', { subscriptionId });
        return null;
      }

      const invoice = subscription.latest_invoice as any;

      logger.info('Invoice details', {
        invoiceId: invoice.id,
        status: invoice.status,
        hasPaymentIntent: !!invoice.payment_intent,
        amountDue: invoice.amount_due
      });

      // The payment intent should exist on the invoice
      if (invoice.payment_intent) {
        const paymentIntent = typeof invoice.payment_intent === 'string'
          ? await stripe.paymentIntents.retrieve(invoice.payment_intent)
          : invoice.payment_intent as Stripe.PaymentIntent;
        
        logger.info('Found payment intent', {
          paymentIntentId: paymentIntent.id,
          status: paymentIntent.status,
          clientSecretExists: !!paymentIntent.client_secret
        });
        
        return paymentIntent.client_secret || null;
      }

      // If we reach here, something is wrong with the subscription setup
      logger.error('Invoice has no payment intent - this indicates a problem with subscription creation', {
        invoiceId: invoice.id,
        subscriptionId
      });

      return null;
    } catch (error: any) {
      logger.error('Failed to get subscription payment intent', { 
        error: error.message,
        code: error.code,
        type: error.type,
        subscriptionId
      });
      throw error;
    }
  }

  async getCustomerInvoices(customerId: string, params: {
    limit?: number;
    starting_after?: string;
    status?: string;
  } = {}) {
    try {
      const listParams: any = {
        customer: customerId,
        limit: params.limit || 10,
        expand: ['data.payment_intent'],
      };

      if (params.starting_after) {
        listParams.starting_after = params.starting_after;
      }

      // Filtered list — the prior debug call (stripe.invoices.list without
      // filters, just to log them) was production code doubling the Stripe
      // rate-limit consumption on every customer-invoices fetch. Removed.
      if (params.status) {
        listParams.status = params.status;
      }

      const invoices = await stripe.invoices.list(listParams);

      logger.info('Retrieved filtered customer invoices', {
        customerId,
        count: invoices.data.length,
        hasMore: invoices.has_more,
        filter: params.status || 'none',
        requestedLimit: params.limit
      });

      return invoices;
    } catch (error) {
      logger.error('Failed to retrieve customer invoices', error);
      throw error;
    }
  }

  // Connected Account Balance & Payouts Methods
  async getConnectedAccountBalance(stripeAccountId: string) {
    try {
      const balance = await stripe.balance.retrieve({}, {
        stripeAccount: stripeAccountId,
      });

      logger.info('Retrieved connected account balance', {
        stripeAccountId,
        availableCount: balance.available.length,
        pendingCount: balance.pending.length,
      });

      return balance;
    } catch (error) {
      logger.error('Failed to retrieve connected account balance', { stripeAccountId, error });
      throw error;
    }
  }

  async listConnectedAccountPayouts(
    stripeAccountId: string,
    params: {
      status?: 'pending' | 'paid' | 'failed' | 'canceled';
      limit?: number;
      starting_after?: string;
      ending_before?: string;
    } = {}
  ) {
    try {
      const payouts = await stripe.payouts.list(
        {
          status: params.status,
          limit: params.limit || 10,
          starting_after: params.starting_after,
          ending_before: params.ending_before,
        },
        {
          stripeAccount: stripeAccountId,
        }
      );

      logger.info('Retrieved connected account payouts', {
        stripeAccountId,
        count: payouts.data.length,
        hasMore: payouts.has_more,
      });

      return payouts;
    } catch (error) {
      logger.error('Failed to list connected account payouts', { stripeAccountId, error });
      throw error;
    }
  }

  async retrieveConnectedAccountPayout(stripeAccountId: string, payoutId: string) {
    try {
      const payout = await stripe.payouts.retrieve(payoutId, {
        stripeAccount: stripeAccountId,
      });

      logger.info('Retrieved connected account payout', {
        stripeAccountId,
        payoutId,
        status: payout.status,
      });

      return payout;
    } catch (error) {
      logger.error('Failed to retrieve connected account payout', { stripeAccountId, payoutId, error });
      throw error;
    }
  }

  async createConnectedAccountPayout(
    stripeAccountId: string,
    params: {
      amount: number; // in dollars
      currency?: string;
      description?: string;
      destination?: string;
      method?: 'standard' | 'instant';
      metadata?: Record<string, string>;
    }
  ) {
    try {
      const payout = await stripe.payouts.create(
        {
          amount: toSmallestUnit(params.amount, params.currency || 'usd'),
          currency: params.currency || 'usd',
          description: params.description,
          destination: params.destination,
          method: params.method || 'standard',
          metadata: params.metadata,
        },
        {
          stripeAccount: stripeAccountId,
        }
      );

      logger.info('Created connected account payout', {
        stripeAccountId,
        payoutId: payout.id,
        amount: params.amount,
        method: params.method || 'standard',
        status: payout.status,
      });

      return payout;
    } catch (error) {
      logger.error('Failed to create connected account payout', { stripeAccountId, params, error });
      throw error;
    }
  }

  async listConnectedAccountExternalAccounts(
    stripeAccountId: string,
    params: { limit?: number } = {}
  ) {
    try {
      const accounts = await stripe.accounts.listExternalAccounts(
        stripeAccountId,
        {
          limit: params.limit || 10,
        }
      );

      logger.info('Retrieved connected account external accounts', {
        stripeAccountId,
        count: accounts.data.length,
      });

      return accounts;
    } catch (error) {
      logger.error('Failed to list connected account external accounts', { stripeAccountId, error });
      throw error;
    }
  }

  async listConnectedAccountCharges(
    stripeAccountId: string,
    params: {
      limit?: number;
      starting_after?: string;
      ending_before?: string;
      created?: {
        gte?: number;
        lte?: number;
      };
    } = {}
  ) {
    try {
      const charges = await stripe.charges.list(
        {
          limit: params.limit || 25,
          starting_after: params.starting_after,
          ending_before: params.ending_before,
          created: params.created,
        },
        {
          stripeAccount: stripeAccountId,
        }
      );

      logger.info('Retrieved connected account charges', {
        stripeAccountId,
        count: charges.data.length,
        hasMore: charges.has_more,
      });

      return charges;
    } catch (error) {
      logger.error('Failed to list connected account charges', { stripeAccountId, error });
      throw error;
    }
  }

  async listConnectedAccountPaymentIntents(
    stripeAccountId: string,
    params: {
      limit?: number;
      starting_after?: string;
      ending_before?: string;
      created?: {
        gte?: number;
        lte?: number;
      };
    } = {}
  ) {
    try {
      const paymentIntents = await stripe.paymentIntents.list(
        {
          limit: params.limit || 25,
          starting_after: params.starting_after,
          ending_before: params.ending_before,
          created: params.created,
        },
        {
          stripeAccount: stripeAccountId,
        }
      );

      logger.info('Retrieved connected account payment intents', {
        stripeAccountId,
        count: paymentIntents.data.length,
        hasMore: paymentIntents.has_more,
      });

      return paymentIntents;
    } catch (error) {
      logger.error('Failed to list connected account payment intents', { stripeAccountId, error });
      throw error;
    }
  }

  async retrieveConnectedAccountCharge(stripeAccountId: string, chargeId: string) {
    try {
      const charge = await stripe.charges.retrieve(chargeId, {
        stripeAccount: stripeAccountId,
      });

      return charge;
    } catch (error) {
      logger.error('Failed to retrieve connected account charge', { stripeAccountId, chargeId, error });
      throw error;
    }
  }

  async createConnectedAccountRefund(
    stripeAccountId: string,
    params: {
      charge?: string;
      payment_intent?: string;
      amount?: number;
      reason?: 'duplicate' | 'fraudulent' | 'requested_by_customer';
      metadata?: Record<string, string>;
    }
  ) {
    try {
      const refund = await stripe.refunds.create(
        {
          charge: params.charge,
          payment_intent: params.payment_intent,
          amount: params.amount, // Already in cents from the API
          reason: params.reason,
          metadata: params.metadata,
        },
        {
          stripeAccount: stripeAccountId,
        }
      );

      logger.info('Created connected account refund', {
        stripeAccountId,
        refundId: refund.id,
        amount: fromSmallestUnit(refund.amount, refund.currency || 'usd'),
      });

      return refund;
    } catch (error) {
      logger.error('Failed to create connected account refund', { stripeAccountId, params, error });
      throw error;
    }
  }
}

export const stripeService = new StripeService();