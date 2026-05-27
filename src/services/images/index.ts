import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import sharp from 'sharp';
import { config } from '../../config';
import { logger } from '../../utils/logger';

// Allowed MIME types for uploads
const ALLOWED_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

// Image type configurations for resizing
export type ImageType = 'product' | 'avatar' | 'event-banner' | 'event-image' | 'branding-logo';

const IMAGE_SIZE_CONFIGS: Record<ImageType, { maxWidth: number; maxHeight: number; quality: number }> = {
  product: { maxWidth: 1200, maxHeight: 1200, quality: 85 },
  avatar: { maxWidth: 400, maxHeight: 400, quality: 90 },
  'event-banner': { maxWidth: 1920, maxHeight: 480, quality: 85 },
  'event-image': { maxWidth: 1200, maxHeight: 675, quality: 85 },
  'branding-logo': { maxWidth: 600, maxHeight: 200, quality: 90 },
};


// Base path for image storage (configurable, defaults to /data/images)
const IMAGE_STORAGE_PATH = config.images.storagePath;
const TEMP_STORAGE_PATH = `${config.images.storagePath}/.tmp`;

export interface UploadResult {
  id: string;
  url: string;
  contentType: string;
  sizeBytes: number;
}

export interface ImageServiceError extends Error {
  code: 'INVALID_TYPE' | 'FILE_TOO_LARGE' | 'STORAGE_ERROR' | 'NOT_FOUND' | 'NOT_CONFIGURED';
}

function createError(message: string, code: ImageServiceError['code']): ImageServiceError {
  const error = new Error(message) as ImageServiceError;
  error.code = code;
  return error;
}

// Image IDs are server-generated (`img_<ts>_<hex>`). Anything a caller passes
// back to address a file MUST match that shape — never a path. This guards
// every fs operation (delete, exists, duplicate, read) against traversal like
// `../../etc/passwd` regardless of which route reached it.
const SAFE_IMAGE_ID = /^[A-Za-z0-9_.-]+$/;
function assertSafeImageId(imageId: string): void {
  if (
    !imageId ||
    imageId.length > 256 ||
    imageId.includes('..') ||
    imageId.includes('/') ||
    imageId.includes('\\') ||
    !SAFE_IMAGE_ID.test(imageId)
  ) {
    throw createError('Invalid image ID', 'NOT_FOUND');
  }
}

/**
 * Generates a unique image ID using timestamp and random bytes
 */
function generateImageId(): string {
  const timestamp = Date.now().toString(36);
  const random = crypto.randomBytes(8).toString('hex');
  return `img_${timestamp}_${random}`;
}

/**
 * Builds the public URL for an image
 */
function buildPublicUrl(imageId: string): string {
  const baseUrl = config.images.fileServerUrl;
  if (!baseUrl) {
    throw createError('Image file server URL not configured', 'NOT_CONFIGURED');
  }
  // Remove trailing slash if present
  const normalizedUrl = baseUrl.replace(/\/$/, '');
  return `${normalizedUrl}/images/${imageId}`;
}

/**
 * Ensures the storage directories exist
 */
async function ensureStorageDirectories(): Promise<void> {
  try {
    await fs.mkdir(IMAGE_STORAGE_PATH, { recursive: true });
    await fs.mkdir(TEMP_STORAGE_PATH, { recursive: true });
  } catch (error) {
    logger.error('Failed to create storage directories', { error });
    throw createError('Storage not available', 'STORAGE_ERROR');
  }
}

/**
 * Validates the uploaded file
 */
function validateFile(
  buffer: ArrayBuffer,
  contentType: string
): void {
  // Validate MIME type
  if (!ALLOWED_MIME_TYPES.has(contentType)) {
    throw createError(
      `Invalid file type: ${contentType}. Allowed types: ${Array.from(ALLOWED_MIME_TYPES).join(', ')}`,
      'INVALID_TYPE'
    );
  }

  // Validate file size
  const maxSize = config.images.maxSizeBytes;
  if (buffer.byteLength > maxSize) {
    throw createError(
      `File too large: ${buffer.byteLength} bytes. Maximum allowed: ${maxSize} bytes (${Math.round(maxSize / 1024 / 1024)}MB)`,
      'FILE_TOO_LARGE'
    );
  }
}

/**
 * Processes and resizes an image based on the image type
 * - Resizes to fit within max dimensions while maintaining aspect ratio
 * - Converts to WebP for better compression (except GIFs which keep animation)
 * - Applies quality optimization
 */
async function processImage(
  buffer: ArrayBuffer,
  contentType: string,
  imageType: ImageType = 'product'
): Promise<{ data: Buffer; contentType: string }> {
  const sizeConfig = IMAGE_SIZE_CONFIGS[imageType];
  const inputBuffer = Buffer.from(buffer);

  try {
    // For GIFs, we keep the original to preserve animation
    // but still resize if needed
    if (contentType === 'image/gif') {
      const metadata = await sharp(inputBuffer).metadata();

      // If GIF is already within limits, return as-is
      if (metadata.width && metadata.height &&
          metadata.width <= sizeConfig.maxWidth &&
          metadata.height <= sizeConfig.maxHeight) {
        return { data: inputBuffer, contentType: 'image/gif' };
      }

      // Resize GIF (note: this will lose animation, so we just return original if too big)
      // For proper GIF resizing with animation, would need gifsicle
      logger.warn('GIF exceeds max dimensions but keeping original to preserve animation', {
        width: metadata.width,
        height: metadata.height,
        maxWidth: sizeConfig.maxWidth,
        maxHeight: sizeConfig.maxHeight,
      });
      return { data: inputBuffer, contentType: 'image/gif' };
    }

    // For other formats, resize and convert to WebP for better compression
    const processed = await sharp(inputBuffer)
      .resize(sizeConfig.maxWidth, sizeConfig.maxHeight, {
        fit: 'inside', // Maintain aspect ratio, fit within bounds
        withoutEnlargement: true, // Don't upscale small images
      })
      .webp({ quality: sizeConfig.quality })
      .toBuffer();

    logger.info('Image processed', {
      imageType,
      originalSize: buffer.byteLength,
      processedSize: processed.byteLength,
      compressionRatio: ((1 - processed.byteLength / buffer.byteLength) * 100).toFixed(1) + '%',
    });

    return { data: processed, contentType: 'image/webp' };
  } catch (error) {
    logger.error('Failed to process image', { error, imageType });
    // If processing fails, return original
    return { data: inputBuffer, contentType };
  }
}

/**
 * Uploads a new image or replaces an existing one
 * Uses atomic write (temp file + rename) for safety
 *
 * @param buffer - The raw image buffer
 * @param contentType - The MIME type of the image
 * @param options - Optional configuration
 * @param options.existingId - If provided, replaces the existing image
 * @param options.imageType - Type of image for sizing ('product' | 'avatar'), defaults to 'product'
 */
export async function uploadImage(
  buffer: ArrayBuffer,
  contentType: string,
  options?: { existingId?: string; imageType?: ImageType }
): Promise<UploadResult> {
  const { existingId, imageType = 'product' } = options || {};

  // Validate file first
  validateFile(buffer, contentType);

  // Process and resize the image
  const processed = await processImage(buffer, contentType, imageType);

  // Ensure storage directories exist
  await ensureStorageDirectories();

  // Use existing ID for replacement or generate new one
  const imageId = existingId || generateImageId();

  // File paths - we store without extension for simpler URL handling
  // But you could include extension: `${imageId}.${ext}`
  const finalPath = path.join(IMAGE_STORAGE_PATH, imageId);
  const tempPath = path.join(TEMP_STORAGE_PATH, `${imageId}_${crypto.randomBytes(4).toString('hex')}`);

  try {
    // Write processed image to temp file first
    await fs.writeFile(tempPath, processed.data);

    // Atomic rename to final location
    await fs.rename(tempPath, finalPath);

    logger.info('Image uploaded successfully', {
      imageId,
      originalContentType: contentType,
      finalContentType: processed.contentType,
      originalSize: buffer.byteLength,
      finalSize: processed.data.byteLength,
      imageType,
      isReplacement: !!existingId,
    });

    return {
      id: imageId,
      url: buildPublicUrl(imageId),
      contentType: processed.contentType,
      sizeBytes: processed.data.byteLength,
    };
  } catch (error) {
    // Clean up temp file if it exists
    try {
      await fs.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }

    logger.error('Failed to upload image', { error, imageId });
    throw createError('Failed to save image', 'STORAGE_ERROR');
  }
}

/**
 * Deletes an image from storage
 */
export async function deleteImage(imageId: string): Promise<boolean> {
  assertSafeImageId(imageId);
  const filePath = path.join(IMAGE_STORAGE_PATH, imageId);

  try {
    await fs.unlink(filePath);
    logger.info('Image deleted successfully', { imageId });
    return true;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.warn('Image not found for deletion', { imageId });
      return false;
    }
    logger.error('Failed to delete image', { error, imageId });
    throw createError('Failed to delete image', 'STORAGE_ERROR');
  }
}

/**
 * Checks if an image exists
 */
export async function imageExists(imageId: string): Promise<boolean> {
  assertSafeImageId(imageId);
  const filePath = path.join(IMAGE_STORAGE_PATH, imageId);

  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Gets the public URL for an image ID
 */
export function getImageUrl(imageId: string | null): string | null {
  if (!imageId) return null;

  try {
    return buildPublicUrl(imageId);
  } catch {
    return null;
  }
}

/**
 * Validates that the image server is configured
 */
export function isImageServerConfigured(): boolean {
  return !!config.images.fileServerUrl;
}

/**
 * Duplicates an existing image with a new ID
 * Used when duplicating products/catalogs
 */
export async function duplicateImage(existingImageId: string): Promise<UploadResult | null> {
  assertSafeImageId(existingImageId);
  const existingPath = path.join(IMAGE_STORAGE_PATH, existingImageId);

  try {
    // Read the existing image
    const buffer = await fs.readFile(existingPath);

    // Generate a new ID
    const newImageId = generateImageId();
    const newPath = path.join(IMAGE_STORAGE_PATH, newImageId);

    // Copy the file
    await fs.writeFile(newPath, buffer);

    logger.info('Image duplicated successfully', {
      originalId: existingImageId,
      newId: newImageId,
    });

    return {
      id: newImageId,
      url: buildPublicUrl(newImageId),
      contentType: 'image/webp', // Assume WebP since we process all images to WebP
      sizeBytes: buffer.byteLength,
    };
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      logger.warn('Image not found for duplication', { existingImageId });
      return null;
    }
    logger.error('Failed to duplicate image', { error, existingImageId });
    return null;
  }
}

export const imageService = {
  upload: uploadImage,
  delete: deleteImage,
  exists: imageExists,
  getUrl: getImageUrl,
  duplicate: duplicateImage,
  isConfigured: isImageServerConfigured,
  maxSizeBytes: config.images.maxSizeBytes,
  allowedTypes: Array.from(ALLOWED_MIME_TYPES),
};
