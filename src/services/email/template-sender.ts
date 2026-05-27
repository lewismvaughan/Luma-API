import { readFileSync } from 'fs';
import { join } from 'path';
import { emailService } from './index';
import { logger } from '../../utils/logger';
import { config } from '../../config';
import { formatCurrency, formatSmallestUnit } from '../../utils/currency';

// Vendor branding for customer-facing emails
export interface VendorBranding {
  organizationName: string;
  brandingLogoUrl: string | null;
}

// Template variable definitions
interface EmailTemplateVariables {
  // Required variables
  subject: string;
  preheader_text: string;
  email_title: string;
  email_content: string; // HTML content that can include paragraphs, lists, etc.
  recipient_email: string;
  current_year: number;
  company_address: string;

  // URLs
  site_url: string;
  dashboard_url: string;
  support_url: string;

  // Optional variables
  cta_url?: string; // Call-to-action button URL
  cta_text?: string; // Call-to-action button text
  secondary_content?: string; // Additional content in highlighted box
  unsubscribe_url?: string; // Unsubscribe link
  security_notice?: boolean; // Show security notice at bottom

  // App download links
  api_url?: string; // API URL for serving static assets
  ios_download_url?: string; // iOS App Store download link
  android_download_url?: string; // Google Play Store download link

  // Vendor branding (for customer-facing emails)
  vendor_name?: string;
  vendor_logo_url?: string;
  vendor_name_header?: string; // Truthy string to show org name as text header
}

// Load and cache the templates
let cachedTemplate: string | null = null;
let cachedVendorTemplate: string | null = null;

function loadTemplate(): string {
  if (!cachedTemplate) {
    const templatePath = join(__dirname, './templates/email-template.html');
    cachedTemplate = readFileSync(templatePath, 'utf-8');
  }
  return cachedTemplate;
}

function loadVendorTemplate(): string {
  if (!cachedVendorTemplate) {
    const templatePath = join(__dirname, './templates/vendor-email-template.html');
    cachedVendorTemplate = readFileSync(templatePath, 'utf-8');
  }
  return cachedVendorTemplate;
}

// Simple template replacement function (without Handlebars)
function replaceTemplateVariables(template: string, variables: EmailTemplateVariables): string {
  let html = template;
  
  // Replace simple variables
  Object.entries(variables).forEach(([key, value]) => {
    if (typeof value !== 'boolean') {
      const regex = new RegExp(`{{${key}}}`, 'g');
      html = html.replace(regex, String(value || ''));
    }
  });
  
  // Handle triple-brace variables (no escaping) - for HTML content
  Object.entries(variables).forEach(([key, value]) => {
    if (typeof value !== 'boolean') {
      const regex = new RegExp(`{{{${key}}}}`, 'g');
      html = html.replace(regex, String(value || ''));
    }
  });
  
  // Handle conditionals
  html = html.replace(/{{#if (\w+)}}([\s\S]*?){{\/if}}/g, (_match, variable, content) => {
    const value = variables[variable as keyof EmailTemplateVariables];
    return value ? content : '';
  });
  
  // Clean up any remaining handlebars syntax
  html = html.replace(/{{[^}]+}}/g, '');
  html = html.replace(/{{{[^}]+}}}/g, '');
  
  return html;
}

// Main function to send templated emails
export async function sendTemplatedEmail(
  to: string,
  templateVariables: Partial<EmailTemplateVariables>
): Promise<void> {
  try {
    // Set default values for required fields
    const currentYear = new Date().getFullYear();
    const defaultVariables: EmailTemplateVariables = {
      subject: 'Message from Luma',
      preheader_text: '',
      email_title: 'Luma Notification',
      email_content: '',
      recipient_email: to,
      current_year: currentYear,
      company_address: 'Luma Inc., San Francisco, CA',
      site_url: config.email.siteUrl!,
      dashboard_url: config.email.dashboardUrl!,
      support_url: config.email.contactUrl!,
      api_url: config.api.url,
      ios_download_url: config.appLinks.ios,
      android_download_url: config.appLinks.android,
    };
    
    // Merge with provided variables
    const variables = { ...defaultVariables, ...templateVariables };
    
    // Load template and replace variables
    const template = loadTemplate();
    const html = replaceTemplateVariables(template, variables);
    
    // Send email using the email service
    await emailService.sendEmail({
      to,
      subject: variables.subject,
      html,
      text: generatePlainText(variables), // Generate plain text version
    });
    
    logger.info('Templated email sent', { to, subject: variables.subject });
  } catch (error) {
    logger.error('Failed to send templated email', { error, to });
    throw error;
  }
}

// Send email using vendor-branded template (for customer-facing emails)
export async function sendVendorTemplatedEmail(
  to: string,
  templateVariables: Partial<EmailTemplateVariables>,
  vendorBranding: VendorBranding
): Promise<void> {
  try {
    const currentYear = new Date().getFullYear();
    const defaultVariables: EmailTemplateVariables = {
      subject: 'Message',
      preheader_text: '',
      email_title: 'Notification',
      email_content: '',
      recipient_email: to,
      current_year: currentYear,
      company_address: '',
      site_url: config.email.siteUrl!,
      dashboard_url: config.email.dashboardUrl!,
      support_url: config.email.contactUrl!,
      api_url: config.api.url,
    };

    // Add vendor branding variables
    const vendorVars: Partial<EmailTemplateVariables> = {
      vendor_name: vendorBranding.organizationName,
    };

    if (vendorBranding.brandingLogoUrl) {
      vendorVars.vendor_logo_url = vendorBranding.brandingLogoUrl;
    } else {
      // Show org name as text header when no logo
      vendorVars.vendor_name_header = 'true';
    }

    const variables = { ...defaultVariables, ...vendorVars, ...templateVariables };

    const template = loadVendorTemplate();
    const html = replaceTemplateVariables(template, variables);

    await emailService.sendEmail({
      to,
      subject: variables.subject,
      html,
      text: generatePlainText(variables),
    });

    logger.info('Vendor templated email sent', { to, subject: variables.subject, vendorName: vendorBranding.organizationName });
  } catch (error) {
    logger.error('Failed to send vendor templated email', { error, to });
    throw error;
  }
}

// Generate plain text version from variables
function generatePlainText(variables: EmailTemplateVariables): string {
  // Strip HTML tags from content
  const plainContent = variables.email_content
    .replace(/<[^>]*>/g, '') // Remove HTML tags
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();
  
  let text = `${variables.email_title}\n\n${plainContent}`;
  
  if (variables.cta_url && variables.cta_text) {
    text += `\n\n${variables.cta_text}: ${variables.cta_url}`;
  }
  
  if (variables.secondary_content) {
    const plainSecondary = variables.secondary_content
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    text += `\n\n${plainSecondary}`;
  }
  
  text += `\n\n---\n© ${variables.current_year} Luma. All rights reserved.\n${variables.company_address}`;
  
  if (variables.security_notice) {
    text += `\n\nThis email was sent to ${variables.recipient_email}. If you didn't request this email, please ignore it or contact support.`;
  }
  
  return text;
}

// Specific email type functions using the template
export async function sendWelcomeEmail(to: string, userData: { firstName: string; organizationName: string; subscriptionTier: string }): Promise<void> {
  const emailContent = `Hi ${userData.firstName},<br><br>
Welcome to Luma! Your account for <strong>${userData.organizationName}</strong> is all set up and ready to go.<br><br>
To get started with your ${userData.subscriptionTier} plan, head over to your dashboard where you can set up payments, create events, manage inventory, and invite your team.<br><br>
Click the button below to access your dashboard and start exploring. You can also download the Luma POS app using the links at the bottom of this email to start accepting payments on your phone.`;

  await sendTemplatedEmail(to, {
    subject: `Welcome to Luma, ${userData.firstName}!`,
    preheader_text: 'Get started with your Luma dashboard',
    email_title: 'Welcome to Luma!',
    email_content: emailContent,
    cta_url: config.email.dashboardUrl!,
    cta_text: 'Go to Your Dashboard',
  });
}

export async function sendPasswordResetEmail(to: string, resetToken: string): Promise<void> {
  const resetUrl = `${config.email.dashboardUrl}/reset-password?token=${resetToken}`;

  // Never log the token or the full reset URL — they are the reset secret.
  logger.info('Preparing password reset email', {
    to,
    dashboardUrl: config.email.dashboardUrl,
    defaultFrom: config.email.defaultFrom
  });
  
  const emailContent = `We received a request to reset your password.<br><br>
Click the button below to create a new password. This link will expire in 10 minutes.<br><br>
If you didn't request this password reset, please ignore this email or contact support if you have concerns.`;
  
  await sendTemplatedEmail(to, {
    subject: 'Reset your password - Luma',
    preheader_text: 'Reset your Luma password',
    email_title: 'Password Reset Request',
    email_content: emailContent,
    cta_url: resetUrl,
    cta_text: 'Reset Password',
    security_notice: true,
  });
}

export async function sendOrderConfirmationEmail(to: string, orderData: any, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  // Format items as a simple list
  const itemsList = orderData.items.map((item: any) =>
    `${item.name} - ${item.quantity} × ${formatCurrency(item.price, currency)}`
  ).join('<br>');

  const emailContent = `Thank you for your order at ${orderData.eventName}!<br><br>
<strong>Order ID:</strong> ${orderData.orderId}<br>
<strong>Date:</strong> ${new Date(orderData.date).toLocaleString()}<br><br>
<strong>Items:</strong><br>
${itemsList}<br><br>
<strong>Total:</strong> ${formatCurrency(orderData.total, currency)}<br>
<strong>Payment Method:</strong> ${orderData.paymentMethod}`;

  const vars = {
    subject: `Order Confirmation - ${orderData.orderId}`,
    preheader_text: 'Thank you for your order',
    email_title: 'Order Confirmed!',
    email_content: emailContent,
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Order', brandingLogoUrl: null });
  }
}

export async function sendReceiptEmail(to: string, receiptData: any, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  // Format items as a simple list
  const itemsList = receiptData.items.map((item: any) =>
    `${item.quantity} ${item.name} - ${formatCurrency(item.subtotal, currency)}`
  ).join('<br>');

  const tipLine = receiptData.tip ? `<br>Tip: ${formatCurrency(receiptData.tip, currency)}` : '';

  const emailContent = `<strong>${receiptData.businessName}</strong><br>
${receiptData.eventName}<br><br>
<strong>Transaction:</strong> ${receiptData.transactionId}<br>
<strong>Date:</strong> ${new Date(receiptData.date).toLocaleString()}<br>
<strong>Cashier:</strong> ${receiptData.cashierName}<br><br>
<strong>Items:</strong><br>
${itemsList}<br><br>
Subtotal: ${formatCurrency(receiptData.subtotal, currency)}<br>
Tax: ${formatCurrency(receiptData.tax, currency)}${tipLine}<br>
<strong>TOTAL: ${formatCurrency(receiptData.total, currency)}</strong><br><br>
Payment: ${receiptData.paymentMethod} ${receiptData.last4 ? `****${receiptData.last4}` : ''}<br><br>
Thank you for your purchase!`;

  const vars = {
    subject: `Receipt - ${receiptData.transactionId}`,
    preheader_text: 'Your purchase receipt',
    email_title: 'Receipt',
    email_content: emailContent,
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Receipt', brandingLogoUrl: null });
  }
}

export async function sendPayoutEmail(to: string, payoutData: any, currency: string = 'usd'): Promise<void> {
  const emailContent = `Great news! Your payout has been processed.<br><br>
<strong>Payout Amount:</strong> ${formatCurrency(payoutData.amount, currency)}<br>
<strong>Payout ID:</strong> ${payoutData.payoutId}<br>
<strong>Processing Date:</strong> ${new Date(payoutData.date).toLocaleDateString()}<br>
<strong>Expected Arrival:</strong> ${payoutData.expectedArrival}<br>
<strong>Bank Account:</strong> ****${payoutData.last4}<br><br>
The funds should arrive in your bank account by ${payoutData.expectedArrival}. Processing times may vary depending on your bank.<br><br>
You can view all your payouts and transaction history in your dashboard.`;

  await sendTemplatedEmail(to, {
    subject: `Payout Processed - ${formatCurrency(payoutData.amount, currency)}`,
    preheader_text: 'Your payout has been processed',
    email_title: 'Payout Confirmation',
    email_content: emailContent,
  });
}

export async function sendStaffInviteEmail(to: string, inviteData: {
  firstName: string;
  inviterName: string;
  organizationName: string;
  inviteToken: string;
}): Promise<void> {
  const acceptUrl = `${config.email.siteUrl}/accept-invite?token=${inviteData.inviteToken}`;

  const emailContent = `Hi ${inviteData.firstName},<br><br>
${inviteData.inviterName} has invited you to join <strong>${inviteData.organizationName}</strong> on Luma POS.<br><br>
As a team member, you'll be able to use the Luma mobile app to process payments, manage orders, and help run the business.<br><br>
Click the button below to set up your account. This invitation expires in 7 days.`;

  await sendTemplatedEmail(to, {
    subject: `You've been invited to join ${inviteData.organizationName} on Luma`,
    preheader_text: `${inviteData.inviterName} has invited you to join their team`,
    email_title: 'You\'re Invited!',
    email_content: emailContent,
    cta_url: acceptUrl,
    cta_text: 'Accept Invitation',
    security_notice: true,
  });
}

export async function sendTicketConfirmationEmail(to: string, ticketData: {
  customerName: string;
  eventName: string;
  eventDate: string;
  eventTime: string;
  eventLocation: string | null;
  eventLocationAddress: string | null;
  tierName: string;
  quantity: number;
  totalAmount: number;
  tickets: { id: string; qrCode: string }[];
  eventSlug: string;
  apiUrl: string;
  eventImageUrl?: string | null;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const ticketRows = ticketData.tickets.map((t, i) => `
    <div style="border: 1px solid #374151; border-radius: 12px; padding: 16px; margin-bottom: 12px; text-align: center;">
      <img src="${ticketData.apiUrl}/tickets/${t.id}/qr.png" alt="QR Code" width="180" height="180" style="display: block; margin: 0 auto 12px;" />
      <p style="margin: 0; font-size: 12px; color: #9CA3AF;">Ticket ${ticketData.quantity > 1 ? `${i + 1} of ${ticketData.quantity}` : ''} · ${ticketData.tierName}</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin: 12px auto 0;" align="center"><tr>
        <td style="padding: 0 6px;" valign="middle"><a href="${ticketData.apiUrl}/tickets/${t.id}/wallet/apple" style="text-decoration: none;" target="_blank"><img src="${ticketData.apiUrl}/public/apple-badge.png" alt="Add to Apple Wallet" height="36" style="display: block; height: 36px; width: auto; border: 0;" /></a></td>
        <td style="padding: 0 6px;" valign="middle"><a href="${ticketData.apiUrl}/tickets/${t.id}/wallet/google" style="text-decoration: none;" target="_blank"><img src="${ticketData.apiUrl}/public/google-badge.png" alt="Add to Google Wallet" height="36" style="display: block; height: 36px; width: auto; border: 0;" /></a></td>
      </tr></table>
      <a href="${ticketData.apiUrl}/tickets/${t.id}/calendar.ics" style="display: inline-block; margin-top: 10px; font-size: 12px; color: #60A5FA; text-decoration: underline;" target="_blank">Add to Calendar</a>
    </div>
  `).join('');

  // Use address for maps link if available, fallback to location name
  const mapsQuery = encodeURIComponent(ticketData.eventLocationAddress || ticketData.eventLocation || '');
  const appleMapsUrl = `https://maps.apple.com/?q=${mapsQuery}`;
  const googleMapsUrl = `https://maps.google.com/maps?q=${mapsQuery}`;
  const locationLine = ticketData.eventLocation
    ? `<br><strong>Location:</strong> ${ticketData.eventLocation}<br><span style="font-size: 12px;"><a href="${appleMapsUrl}" style="color: #60A5FA; text-decoration: underline;" target="_blank">Apple Maps</a> · <a href="${googleMapsUrl}" style="color: #60A5FA; text-decoration: underline;" target="_blank">Google Maps</a></span>`
    : '';

  const eventBanner = ticketData.eventImageUrl
    ? `<div style="margin: 0 0 24px 0; border-radius: 12px; overflow: hidden;"><img src="${ticketData.eventImageUrl}" alt="${ticketData.eventName}" width="520" style="display: block; width: 100%; height: auto; border-radius: 12px;" /></div>`
    : '';

  const emailContent = `${eventBanner}Hi ${ticketData.customerName},<br><br>
Your ticket${ticketData.quantity > 1 ? 's are' : ' is'} confirmed for <strong>${ticketData.eventName}</strong>!<br><br>
<strong>Date:</strong> ${ticketData.eventDate}<br>
<strong>Time:</strong> ${ticketData.eventTime}${locationLine}<br>
<strong>Ticket:</strong> ${ticketData.tierName} × ${ticketData.quantity}<br>
<strong>Total:</strong> ${ticketData.totalAmount === 0 ? 'Free' : formatCurrency(ticketData.totalAmount, currency)}<br><br>
Show the QR code${ticketData.quantity > 1 ? 's' : ''} below at the door:<br><br>
${ticketRows}`;

  const siteUrl = config.email.siteUrl || 'https://lumapos.co';

  const vars = {
    subject: `Your ticket${ticketData.quantity > 1 ? 's' : ''} for ${ticketData.eventName}`,
    preheader_text: `You're in! Show this QR code at the door.`,
    email_title: `You're In!`,
    email_content: emailContent,
    cta_url: `${siteUrl}/events/${ticketData.eventSlug}`,
    cta_text: 'View Event Details',
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    // Always use vendor template for customer-facing ticket emails
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Event', brandingLogoUrl: null });
  }
}

export async function sendStaffDisabledEmail(to: string, staffData: {
  firstName: string;
  organizationName: string;
}): Promise<void> {
  const emailContent = `Hi ${staffData.firstName},<br><br>
Your access to <strong>${staffData.organizationName}</strong> on Luma has been temporarily disabled because the organization's subscription is no longer active.<br><br>
Please contact your organization administrator for more information.`;

  await sendTemplatedEmail(to, {
    subject: 'Your Luma account has been temporarily disabled',
    preheader_text: 'Your account access has been temporarily disabled',
    email_title: 'Account Access Disabled',
    email_content: emailContent,
  });
}

export async function sendTicketRefundEmail(to: string, refundData: {
  customerName: string;
  eventName: string;
  eventDate: string;
  tierName: string;
  refundAmount: number;
  isFullRefund: boolean;
  reason?: string;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const reasonLine = refundData.reason
    ? `<br><strong>Reason:</strong> ${refundData.reason}`
    : '';

  const emailContent = `Hi ${refundData.customerName},<br><br>
${refundData.isFullRefund
    ? `Your ticket for <strong>${refundData.eventName}</strong> has been refunded.`
    : `A partial refund has been issued for your ticket to <strong>${refundData.eventName}</strong>.`
}<br><br>
<strong>Event:</strong> ${refundData.eventName}<br>
<strong>Date:</strong> ${refundData.eventDate}<br>
<strong>Ticket:</strong> ${refundData.tierName}<br>
<strong>Refund Amount:</strong> ${formatCurrency(refundData.refundAmount, currency)}${reasonLine}<br><br>
The refund will be credited back to your original payment method within 5-10 business days, depending on your bank.<br><br>
If you have any questions, please contact the event organizer.`;

  const vars = {
    subject: `Refund Processed - ${refundData.eventName}`,
    preheader_text: `Your ${formatCurrency(refundData.refundAmount, currency)} refund has been processed`,
    email_title: 'Refund Processed',
    email_content: emailContent,
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Event', brandingLogoUrl: null });
  }
}

export async function sendTicketReminderEmail(to: string, ticketData: {
  customerName: string;
  eventName: string;
  eventDate: string;
  eventTime: string;
  eventLocation: string | null;
  eventLocationAddress: string | null;
  tickets: { id: string; qrCode: string }[];
  eventSlug: string;
  apiUrl: string;
  eventImageUrl?: string | null;
}, vendorBranding?: VendorBranding): Promise<void> {
  // Use address for maps link if available, fallback to location name
  const mapsQuery = encodeURIComponent(ticketData.eventLocationAddress || ticketData.eventLocation || '');
  const appleMapsUrl = `https://maps.apple.com/?q=${mapsQuery}`;
  const googleMapsUrl = `https://maps.google.com/maps?q=${mapsQuery}`;
  const locationLine = ticketData.eventLocation
    ? `<br><strong>Location:</strong> ${ticketData.eventLocation}<br><span style="font-size: 12px;"><a href="${appleMapsUrl}" style="color: #60A5FA; text-decoration: underline;" target="_blank">Apple Maps</a> · <a href="${googleMapsUrl}" style="color: #60A5FA; text-decoration: underline;" target="_blank">Google Maps</a></span>`
    : '';

  const qrSection = ticketData.tickets.map((t, i) => `
    <div style="border: 1px solid #374151; border-radius: 12px; padding: 16px; margin-bottom: 12px; text-align: center;">
      <img src="${ticketData.apiUrl}/tickets/${t.id}/qr.png" alt="QR Code" width="160" height="160" style="display: block; margin: 0 auto 8px;" />
      <p style="margin: 0; font-size: 12px; color: #9CA3AF;">Ticket${ticketData.tickets.length > 1 ? ` ${i + 1} of ${ticketData.tickets.length}` : ''}</p>
    </div>
  `).join('');

  const siteUrl = config.email.siteUrl || 'https://lumapos.co';

  const eventBanner = ticketData.eventImageUrl
    ? `<div style="margin: 0 0 24px 0; border-radius: 12px; overflow: hidden;"><img src="${ticketData.eventImageUrl}" alt="${ticketData.eventName}" width="520" style="display: block; width: 100%; height: auto; border-radius: 12px;" /></div>`
    : '';

  const emailContent = `${eventBanner}Hi ${ticketData.customerName},<br><br>
Just a friendly reminder — <strong>${ticketData.eventName}</strong> is tomorrow!<br><br>
<strong>Date:</strong> ${ticketData.eventDate}<br>
<strong>Time:</strong> ${ticketData.eventTime}${locationLine}<br><br>
Here's your QR code${ticketData.tickets.length > 1 ? 's' : ''} to show at the door:<br><br>
${qrSection}`;

  const vars = {
    subject: `Reminder: ${ticketData.eventName} is tomorrow!`,
    preheader_text: `${ticketData.eventName} is tomorrow — don't forget your ticket!`,
    email_title: 'Event Tomorrow!',
    email_content: emailContent,
    cta_url: `${siteUrl}/events/${ticketData.eventSlug}`,
    cta_text: 'View Event Details',
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    // Always use vendor template for customer-facing ticket emails
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Event', brandingLogoUrl: null });
  }
}

// Helper to format ready time nicely
function formatReadyTime(isoString: string): string {
  const date = new Date(isoString);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  };

  const timeStr = date.toLocaleTimeString('en-US', timeOptions);

  if (isToday) {
    // Calculate minutes from now
    const diffMs = date.getTime() - now.getTime();
    const diffMins = Math.round(diffMs / 60000);

    if (diffMins > 0 && diffMins <= 60) {
      return `~${diffMins} minutes (${timeStr})`;
    }
    return `Today at ${timeStr}`;
  }

  // For other days, include the date
  const dateOptions: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };
  const dateStr = date.toLocaleDateString('en-US', dateOptions);
  return `${dateStr} at ${timeStr}`;
}

// Preorder email functions
export async function sendPreorderConfirmationEmail(to: string, preorderData: {
  customerName: string;
  orderNumber: string;
  dailyNumber?: number;
  catalogName: string;
  items: { name: string; quantity: number; unitPrice: number }[];
  subtotal: number;
  taxAmount: number;
  tipAmount: number;
  totalAmount: number;
  paymentType: 'pay_now' | 'pay_at_pickup';
  estimatedReadyAt: string | null;
  pickupInstructions: string | null;
  trackingUrl: string;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const itemsList = preorderData.items.map(item =>
    `${item.quantity} × ${item.name} — ${formatCurrency(item.unitPrice, currency)}`
  ).join('<br>');

  const tipLine = preorderData.tipAmount > 0
    ? `<br>Tip: ${formatCurrency(preorderData.tipAmount, currency)}`
    : '';

  const paymentStatusLine = preorderData.paymentType === 'pay_now'
    ? '<br><span style="color: #10B981;">✓ Paid</span>'
    : '<br><span style="color: #F59E0B;">Payment due at pickup</span>';

  const estimatedTime = preorderData.estimatedReadyAt
    ? `<br><strong>Estimated Ready:</strong> ${formatReadyTime(preorderData.estimatedReadyAt)}`
    : '';

  const pickupInfo = preorderData.pickupInstructions
    ? `<br><br><strong>Pickup Instructions:</strong><br>${preorderData.pickupInstructions}`
    : '';

  const emailContent = `Hi ${preorderData.customerName},<br><br>
Your pre-order has been received! Here are your order details:<br><br>
<strong>Order #:</strong> ${preorderData.dailyNumber ? `#${preorderData.dailyNumber}` : preorderData.orderNumber}<br>
<strong>Menu:</strong> ${preorderData.catalogName}${estimatedTime}<br><br>
<strong>Items:</strong><br>
${itemsList}<br><br>
Subtotal: ${formatCurrency(preorderData.subtotal, currency)}<br>
Tax: ${formatCurrency(preorderData.taxAmount, currency)}${tipLine}<br>
<strong>Total: ${formatCurrency(preorderData.totalAmount, currency)}</strong>${paymentStatusLine}${pickupInfo}<br><br>
Track your order status in real-time using the button below. We'll also email you when your order is ready!`;

  const vars = {
    subject: `Pre-Order Confirmed - #${preorderData.dailyNumber || preorderData.orderNumber}`,
    preheader_text: `Your pre-order #${preorderData.dailyNumber || preorderData.orderNumber} has been received`,
    email_title: 'Pre-Order Confirmed!',
    email_content: emailContent,
    cta_url: preorderData.trackingUrl,
    cta_text: 'Track Your Order',
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Order', brandingLogoUrl: null });
  }
}

export async function sendPreorderReadyEmail(to: string, preorderData: {
  customerName: string;
  orderNumber: string;
  dailyNumber?: number;
  catalogName: string;
  totalAmount: number;
  paymentType: 'pay_now' | 'pay_at_pickup';
  pickupInstructions: string | null;
  trackingUrl: string;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const paymentReminder = preorderData.paymentType === 'pay_at_pickup'
    ? `<br><br><strong>Payment:</strong> ${formatCurrency(preorderData.totalAmount, currency)} due at pickup`
    : '';

  const pickupInfo = preorderData.pickupInstructions
    ? `<br><br><strong>Pickup Instructions:</strong><br>${preorderData.pickupInstructions}`
    : '';

  const emailContent = `Hi ${preorderData.customerName},<br><br>
Great news! Your pre-order is <strong>ready for pickup</strong>!<br><br>
<strong>Order #:</strong> ${preorderData.dailyNumber ? `#${preorderData.dailyNumber}` : preorderData.orderNumber}<br>
<strong>Menu:</strong> ${preorderData.catalogName}${paymentReminder}${pickupInfo}<br><br>
Please come pick up your order at your earliest convenience. Show your order number or this email when you arrive.`;

  const vars = {
    subject: `Your Order #${preorderData.dailyNumber || preorderData.orderNumber} is Ready! 🎉`,
    preheader_text: `Your pre-order is ready for pickup`,
    email_title: 'Your Order is Ready!',
    email_content: emailContent,
    cta_url: preorderData.trackingUrl,
    cta_text: 'View Order',
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Order', brandingLogoUrl: null });
  }
}

// Invoice email functions
export async function sendInvoiceEmail(to: string, invoiceData: {
  customerName: string;
  invoiceNumber: string;
  organizationName: string;
  items: { description: string; quantity: number; unitPrice: number; amount: number }[];
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  dueDate: string | null;
  memo: string | null;
  hostedUrl: string;
  pdfUrl: string | null;
  isReminder?: boolean;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const itemsList = invoiceData.items.map(item =>
    `${item.description} — ${item.quantity} × ${formatCurrency(item.unitPrice, currency)} = ${formatCurrency(item.amount, currency)}`
  ).join('<br>');

  const taxLine = invoiceData.taxAmount > 0
    ? `<br>Tax: ${formatCurrency(invoiceData.taxAmount, currency)}`
    : '';

  const dueDateLine = invoiceData.dueDate
    ? `<br><strong>Due Date:</strong> ${new Date(invoiceData.dueDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
    : '';

  const memoLine = invoiceData.memo
    ? `<br><br><em>${invoiceData.memo}</em>`
    : '';

  const isReminder = invoiceData.isReminder === true;

  const introLine = isReminder
    ? `This is a friendly reminder that you have an outstanding invoice from <strong>${invoiceData.organizationName}</strong>.`
    : `You have a new invoice from <strong>${invoiceData.organizationName}</strong>.`;

  const emailContent = `Hi ${invoiceData.customerName},<br><br>
${introLine}<br><br>
<strong>Invoice #:</strong> ${invoiceData.invoiceNumber}${dueDateLine}<br><br>
<strong>Items:</strong><br>
${itemsList}<br><br>
Subtotal: ${formatCurrency(invoiceData.subtotal, currency)}${taxLine}<br>
<strong>Total Due: ${formatCurrency(invoiceData.totalAmount, currency)}</strong>${memoLine}<br><br>
Click the button below to view and pay your invoice securely.`;

  const vars = {
    subject: isReminder
      ? `Reminder: Invoice ${invoiceData.invoiceNumber} from ${invoiceData.organizationName}`
      : `Invoice ${invoiceData.invoiceNumber} from ${invoiceData.organizationName}`,
    preheader_text: isReminder
      ? `Reminder: You have a ${formatCurrency(invoiceData.totalAmount, currency)} invoice from ${invoiceData.organizationName}`
      : `You have a ${formatCurrency(invoiceData.totalAmount, currency)} invoice from ${invoiceData.organizationName}`,
    email_title: isReminder ? 'Payment Reminder' : 'Invoice',
    email_content: emailContent,
    cta_url: invoiceData.hostedUrl,
    cta_text: 'View & Pay Invoice',
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: invoiceData.organizationName, brandingLogoUrl: null });
  }
}

export async function sendInvoicePaidEmail(to: string, invoiceData: {
  customerName: string;
  invoiceNumber: string;
  organizationName: string;
  totalAmount: number;
  pdfUrl: string | null;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const pdfLine = invoiceData.pdfUrl
    ? `<br><br><a href="${invoiceData.pdfUrl}" style="color: #60A5FA; text-decoration: underline;">Download PDF Receipt</a>`
    : '';

  const emailContent = `Hi ${invoiceData.customerName},<br><br>
Thank you! Your payment of <strong>${formatCurrency(invoiceData.totalAmount, currency)}</strong> for invoice <strong>${invoiceData.invoiceNumber}</strong> from <strong>${invoiceData.organizationName}</strong> has been received.<br><br>
No further action is needed.${pdfLine}`;

  const vars = {
    subject: `Payment Received - Invoice ${invoiceData.invoiceNumber}`,
    preheader_text: `Your payment of ${formatCurrency(invoiceData.totalAmount, currency)} has been received`,
    email_title: 'Payment Received',
    email_content: emailContent,
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: invoiceData.organizationName, brandingLogoUrl: null });
  }
}

export async function sendInvoicePaymentFailedEmail(to: string, invoiceData: {
  customerName: string;
  invoiceNumber: string;
  organizationName: string;
  totalAmount: number;
  hostedUrl: string;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const emailContent = `Hi ${invoiceData.customerName},<br><br>
We were unable to process your payment of <strong>${formatCurrency(invoiceData.totalAmount, currency)}</strong> for invoice <strong>${invoiceData.invoiceNumber}</strong> from <strong>${invoiceData.organizationName}</strong>.<br><br>
Please try again using the button below. If you continue to experience issues, contact the vendor directly.`;

  const vars = {
    subject: `Payment Failed - Invoice ${invoiceData.invoiceNumber}`,
    preheader_text: `Your payment for invoice ${invoiceData.invoiceNumber} could not be processed`,
    email_title: 'Payment Failed',
    email_content: emailContent,
    cta_url: invoiceData.hostedUrl,
    cta_text: 'Retry Payment',
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: invoiceData.organizationName, brandingLogoUrl: null });
  }
}

export async function sendInvoiceRefundedEmail(to: string, invoiceData: {
  customerName: string;
  invoiceNumber: string;
  organizationName: string;
  refundAmount: number;
  totalAmount: number;
  isFullRefund: boolean;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const refundType = invoiceData.isFullRefund ? 'full' : 'partial';
  const emailContent = `Hi ${invoiceData.customerName},<br><br>
A ${refundType} refund of <strong>${formatCurrency(invoiceData.refundAmount, currency)}</strong> has been issued for invoice <strong>${invoiceData.invoiceNumber}</strong> from <strong>${invoiceData.organizationName}</strong>.<br><br>
The refund will be returned to your original payment method. Please allow 5-10 business days for the refund to appear on your statement.`;

  const vars = {
    subject: `Refund Issued - Invoice ${invoiceData.invoiceNumber}`,
    preheader_text: `A refund of ${formatCurrency(invoiceData.refundAmount, currency)} has been issued`,
    email_title: 'Refund Issued',
    email_content: emailContent,
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: invoiceData.organizationName, brandingLogoUrl: null });
  }
}

export async function sendPreorderCancelledEmail(to: string, preorderData: {
  customerName: string;
  orderNumber: string;
  dailyNumber?: number;
  catalogName: string;
  totalAmount: number;
  paymentType: 'pay_now' | 'pay_at_pickup';
  refundIssued: boolean;
  cancellationReason?: string;
}, vendorBranding?: VendorBranding, currency: string = 'usd'): Promise<void> {
  const reasonLine = preorderData.cancellationReason
    ? `<br><strong>Reason:</strong> ${preorderData.cancellationReason}`
    : '';

  const isRefund = preorderData.refundIssued;

  const refundInfo = isRefund
    ? `<br><br>A refund of <strong>${formatCurrency(preorderData.totalAmount, currency)}</strong> has been issued to your original payment method. Please allow 5-10 business days for the refund to appear on your statement.`
    : '';

  const titleText = isRefund ? 'Order Refunded' : 'Order Cancelled';
  const bodyText = isRefund ? 'Your pre-order has been refunded.' : 'Your pre-order has been cancelled.';
  const contactText = isRefund ? 'this refund' : 'this cancellation';

  const emailContent = `Hi ${preorderData.customerName},<br><br>
${bodyText}<br><br>
<strong>Order #:</strong> ${preorderData.dailyNumber ? `#${preorderData.dailyNumber}` : preorderData.orderNumber}<br>
<strong>Menu:</strong> ${preorderData.catalogName}${reasonLine}${refundInfo}<br><br>
If you have any questions about ${contactText}, please contact the vendor directly.<br><br>
We hope to serve you again soon!`;

  const vars = {
    subject: `Pre-Order #${preorderData.dailyNumber || preorderData.orderNumber} ${isRefund ? 'Refunded' : 'Cancelled'}`,
    preheader_text: bodyText,
    email_title: titleText,
    email_content: emailContent,
  };

  if (vendorBranding) {
    await sendVendorTemplatedEmail(to, vars, vendorBranding);
  } else {
    await sendVendorTemplatedEmail(to, vars, { organizationName: 'Order', brandingLogoUrl: null });
  }
}

export async function sendDisputeCreatedEmail(to: string, disputeData: {
  firstName: string;
  organizationName: string;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  stripeDashboardUrl: string;
  evidenceDueBy: string | null;
}): Promise<void> {
  const amountFormatted = formatSmallestUnit(disputeData.amount, disputeData.currency);
  const reasonFormatted = disputeData.reason.replace(/_/g, ' ');
  const deadlineLine = disputeData.evidenceDueBy
    ? `<br><strong>Evidence Deadline:</strong> ${new Date(disputeData.evidenceDueBy).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`
    : '';

  const emailContent = `Hi ${disputeData.firstName},<br><br>
A payment dispute (chargeback) has been filed against <strong>${disputeData.organizationName}</strong>.<br><br>
<strong>Amount:</strong> ${amountFormatted}<br>
<strong>Reason:</strong> ${reasonFormatted}${deadlineLine}<br><br>
To respond to this dispute and submit evidence, go to your Stripe Dashboard using the button below. Failure to respond before the deadline may result in the funds being permanently returned to the customer.<br><br>
<strong>Important:</strong> Do not ignore this dispute. Even if you believe the charge was legitimate, you must submit evidence through Stripe.`;

  await sendTemplatedEmail(to, {
    subject: `Action Required: Payment Dispute - ${amountFormatted}`,
    preheader_text: `A ${amountFormatted} dispute has been filed. Respond before the deadline.`,
    email_title: 'Payment Dispute Filed',
    email_content: emailContent,
    cta_url: disputeData.stripeDashboardUrl,
    cta_text: 'View in Stripe Dashboard',
  });
}