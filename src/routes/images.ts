import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from 'zod';
import * as fs from 'fs/promises';
import * as path from 'path';
import { imageService } from '../services/images';
import { logger } from '../utils/logger';
import { config } from '../config';

const app = new OpenAPIHono();

// Helper to verify token and get user info
async function verifyAuth(authHeader: string | undefined) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized');
  }
  const token = authHeader.substring(7);
  const { authService } = await import('../services/auth');
  return authService.verifyToken(token);
}

// Serve image (public - no auth required)
const getImageRoute = createRoute({
  method: 'get',
  path: '/images/{imageId}',
  summary: 'Get an image by ID',
  tags: ['Images'],
  request: {
    params: z.object({
      imageId: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Image file',
      content: {
        'image/*': {
          schema: z.any(),
        },
      },
    },
    404: { description: 'Image not found' },
  },
});

app.openapi(getImageRoute, async (c) => {
  const { imageId } = c.req.param();

  // Sanitize imageId to prevent path traversal
  if (imageId.includes('..') || imageId.includes('/') || imageId.includes('\\')) {
    return c.json({ error: 'Invalid image ID' }, 400);
  }

  const filePath = path.join(config.images.storagePath, imageId);

  try {
    const fileBuffer = await fs.readFile(filePath);

    // Try to determine content type from file magic bytes
    let contentType = 'application/octet-stream';
    if (fileBuffer[0] === 0xFF && fileBuffer[1] === 0xD8) {
      contentType = 'image/jpeg';
    } else if (fileBuffer[0] === 0x89 && fileBuffer[1] === 0x50) {
      contentType = 'image/png';
    } else if (fileBuffer[0] === 0x47 && fileBuffer[1] === 0x49) {
      contentType = 'image/gif';
    } else if (fileBuffer[0] === 0x52 && fileBuffer[1] === 0x49) {
      contentType = 'image/webp';
    }

    return new Response(fileBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return c.json({ error: 'Image not found' }, 404);
    }
    logger.error('Error serving image', { error, imageId });
    return c.json({ error: 'Failed to serve image' }, 500);
  }
});

// Upload image
const uploadImageRoute = createRoute({
  method: 'post',
  path: '/images/upload',
  summary: 'Upload an image',
  tags: ['Images'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'multipart/form-data': {
          schema: z.object({
            file: z.any(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Image uploaded successfully',
      content: {
        'application/json': {
          schema: z.object({
            id: z.string(),
            url: z.string(),
            contentType: z.string(),
            sizeBytes: z.number(),
          }),
        },
      },
    },
    400: { description: 'Invalid file' },
    401: { description: 'Unauthorized' },
    500: { description: 'Upload failed' },
  },
});

app.openapi(uploadImageRoute, async (c) => {
  try {
    await verifyAuth(c.req.header('Authorization'));

    // Check if image server is configured
    if (!imageService.isConfigured()) {
      return c.json({ error: 'Image uploads not configured' }, 500);
    }

    const formData = await c.req.formData();
    const file = formData.get('file');

    // Use duck typing - File is not available in Node.js
    const isFileLike = file && typeof file === 'object' && 'arrayBuffer' in file && 'type' in file;
    if (!isFileLike) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const uploadedFile = file as Blob;
    const buffer = await uploadedFile.arrayBuffer();
    const result = await imageService.upload(buffer, uploadedFile.type, { imageType: 'product' });

    logger.info('Image uploaded', { imageId: result.id, size: result.sizeBytes });

    return c.json(result);
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (error.code === 'INVALID_TYPE') {
      return c.json({ error: error.message }, 400);
    }
    if (error.code === 'FILE_TOO_LARGE') {
      return c.json({ error: error.message }, 400);
    }
    logger.error('Error uploading image', { error });
    return c.json({ error: 'Failed to upload image' }, 500);
  }
});

// Delete image
const deleteImageRoute = createRoute({
  method: 'delete',
  path: '/images/{imageId}',
  summary: 'Delete an image',
  tags: ['Images'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      imageId: z.string(),
    }),
  },
  responses: {
    200: { description: 'Image deleted' },
    401: { description: 'Unauthorized' },
    404: { description: 'Image not found' },
  },
});

app.openapi(deleteImageRoute, async (c) => {
  const { imageId } = c.req.param();

  // Reject path-traversal in the id before touching the filesystem (mirrors
  // the GET route; the image service also guards, this returns a clean 400).
  if (imageId.includes('..') || imageId.includes('/') || imageId.includes('\\')) {
    return c.json({ error: 'Invalid image ID' }, 400);
  }

  try {
    await verifyAuth(c.req.header('Authorization'));

    const deleted = await imageService.delete(imageId);

    if (!deleted) {
      return c.json({ error: 'Image not found' }, 404);
    }

    logger.info('Image deleted', { imageId });
    return c.json({ success: true });
  } catch (error: any) {
    if (error.message === 'Unauthorized' || error.message === 'Invalid token') {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    logger.error('Error deleting image', { error, imageId });
    return c.json({ error: 'Failed to delete image' }, 500);
  }
});

export default app;
