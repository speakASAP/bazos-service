import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from '../logger/logger.service';

type CatalogScope = 'own' | 'effective' | 'alfares' | 'community' | 'all';

/**
 * API client for catalog-microservice
 * Fetches product data from the central catalog
 */
@Injectable()
export class CatalogClientService {
  private readonly baseUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly logger: LoggerService,
  ) {
    this.baseUrl = process.env.CATALOG_SERVICE_URL || 'http://catalog-microservice:3200';
  }

  /**
   * A failed catalog lookup must never be reported as "no such product/price".
   *
   * Returning null/empty behind a logger.warn is why a 26-day warehouse stock
   * outage and a same-day search outage went unnoticed: an auth or transport
   * failure was indistinguishable from a genuinely absent result. Only a 404
   * means "no such record" — everything else must throw.
   */
  private rethrowCatalogLookupFailure(error: unknown, subject: string, operation: string): never {
    const status = (error as any)?.response?.status;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const errorStack = error instanceof Error ? error.stack : undefined;
    this.logger.error(
      `${operation} failed against catalog-microservice: ${subject}, `
        + `httpStatus=${status ?? 'n/a'}, error=${errorMessage}`,
      errorStack,
      'CatalogClient',
    );
    throw new HttpException(
      `${operation} failed: ${errorMessage}`,
      status || HttpStatus.BAD_GATEWAY,
    );
  }

  /**
   * Get product by ID
   */
  async getProductById(productId: string, authorization?: string, catalogScope?: CatalogScope): Promise<any> {
    try {
      const params = new URLSearchParams();
      if (catalogScope) params.set('catalogScope', catalogScope);
      const queryString = params.toString();
      const productPath = `${this.baseUrl}/api/products/${encodeURIComponent(productId)}${queryString ? `?${queryString}` : ''}`;
      const response = await firstValueFrom(
        this.httpService.get(productPath, this.authOptions(authorization))
      );
      return response.data.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to get product ${productId}: ${errorMessage}`, errorStack, 'CatalogClient');
      throw new HttpException(`Product not found: ${productId}`, HttpStatus.NOT_FOUND);
    }
  }

  /**
   * Get marketplace-ready canonical content preview for a product
   */
  async getProductContentPreview(productId: string, marketplace: string, authorization?: string): Promise<any | null> {
    const cleanProductId = productId.trim();
    const cleanMarketplace = marketplace.trim();
    if (!cleanProductId || !cleanMarketplace) return null;

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.baseUrl}/api/products/${encodeURIComponent(cleanProductId)}/content-previews/${encodeURIComponent(cleanMarketplace)}`,
          this.authOptions(authorization),
        )
      );
      if (!response.data?.success || !response.data?.data) {
        return null;
      }
      return response.data.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(
        `Content preview not found for product ${cleanProductId} marketplace ${cleanMarketplace}: ${errorMessage}`,
        'CatalogClient',
      );
      return null;
    }
  }

  /**
   * Get product readiness diagnostics from Catalog product truth.
   */
  async getProductReadiness(productId: string, authorization?: string): Promise<any> {
    const cleanProductId = productId.trim();
    if (!cleanProductId) {
      throw new HttpException('Catalog product id is required for readiness check', HttpStatus.BAD_REQUEST);
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get(
          `${this.baseUrl}/api/products/${encodeURIComponent(cleanProductId)}/readiness`,
          this.authOptions(authorization),
        )
      );
      if (response.data?.success === false) {
        throw new Error(response.data?.message || 'Catalog readiness request was rejected');
      }
      return response.data?.data || response.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Product readiness unavailable for ${cleanProductId}: ${errorMessage}`, 'CatalogClient');
      throw new HttpException('Catalog product readiness unavailable', HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * Get product by SKU
   */
  async getProductBySku(sku: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/api/products/sku/${sku}`)
      );
      if (!response.data.success || !response.data.data) {
        return null;
      }
      return response.data.data;
    } catch (error: unknown) {
      // A lookup failure is not "no such SKU": returning null for both made an
      // auth or transport failure indistinguishable from a genuinely unknown
      // product. Only a 404 means "no such SKU".
      if ((error as any)?.response?.status === HttpStatus.NOT_FOUND) {
        return null;
      }
      this.rethrowCatalogLookupFailure(error, `sku=${sku}`, 'Product lookup by SKU');
    }
  }

  /**
   * Search products
   */
  async searchProducts(query: {
    search?: string;
    isActive?: boolean;
    categoryId?: string;
    catalogScope?: CatalogScope;
    page?: number;
    limit?: number;
  }, authorization?: string): Promise<{ items: any[]; total: number; page: number; limit: number }> {
    try {
      const params = new URLSearchParams();
      if (query.search) params.append('search', query.search);
      if (query.isActive !== undefined) params.append('isActive', String(query.isActive));
      if (query.categoryId) params.append('categoryId', query.categoryId);
      if (query.catalogScope) params.append('catalogScope', query.catalogScope);
      if (query.page) params.append('page', String(query.page));
      if (query.limit) params.append('limit', String(query.limit));

      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/api/products?${params.toString()}`, this.authOptions(authorization))
      );
      return {
        items: response.data.data || [],
        total: response.data.pagination?.total || 0,
        page: response.data.pagination?.page || 1,
        limit: response.data.pagination?.limit || 20,
      };
    } catch (error: unknown) {
      // Was `return { items: [], ... }` on any error, so a 401 was
      // indistinguishable from a catalog with no matching products. This client
      // backs the Bazos duplicate-ad-prevention search (BazosAdService
      // .findSimilarCatalogProduct) — a false "no matches" here creates a
      // duplicate catalog product/ad instead of reusing the existing one.
      this.rethrowCatalogLookupFailure(error, 'search', 'Product search');
    }
  }

  /**
   * Provision idempotent user Catalog access after hosted Auth login.
   */
  async provisionAccess(authorization: string, sourceApplication = 'bazos'): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/api/catalog/access/provision`,
          { sourceApplication },
          this.authOptions(authorization),
        )
      );
      return response.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.warn(`Failed to provision Catalog access: ${errorMessage}`, 'CatalogClient');
      throw new HttpException('Failed to provision Catalog access', HttpStatus.BAD_GATEWAY);
    }
  }

  /**
   * Create product in catalog
   */
  async createProduct(productData: any, authorization?: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/api/products`, productData, this.authOptions(authorization))
      );
      return response.data.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to create product: ${errorMessage}`, errorStack, 'CatalogClient');
      throw new HttpException(`Failed to create product: ${errorMessage}`, HttpStatus.BAD_REQUEST);
    }
  }

  /**
   * Update product in catalog
   */
  async updateProduct(productId: string, productData: any, authorization?: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.put(`${this.baseUrl}/api/products/${productId}`, productData, this.authOptions(authorization))
      );
      return response.data.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`Failed to update product ${productId}: ${errorMessage}`, errorStack, 'CatalogClient');
      throw new HttpException(`Failed to update product: ${errorMessage}`, HttpStatus.BAD_REQUEST);
    }
  }


  /**
   * Upload product media file to catalog storage
   */
  async uploadMedia(file: any, data: { productId: string; altText?: string; position?: number; isPrimary?: boolean }, authorization?: string): Promise<any> {
    try {
      const formData = new (globalThis as any).FormData();
      const blob = new (globalThis as any).Blob([file.buffer], { type: file.mimetype || 'application/octet-stream' });
      formData.append('file', blob, file.originalname || 'bazos-photo.jpg');
      formData.append('productId', data.productId);
      if (data.altText) formData.append('altText', data.altText);
      if (Number.isFinite(data.position)) formData.append('position', String(data.position));
      if (data.isPrimary !== undefined) formData.append('isPrimary', String(Boolean(data.isPrimary)));
      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/api/media/upload`, formData, this.authOptions(authorization))
      );
      return response.data.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.warn(`Failed to upload product media: ${errorMessage}`, 'CatalogClient');
      if (errorStack) this.logger.warn(errorStack, 'CatalogClient');
      return null;
    }
  }

  /**
   * Create external media reference for product
   */
  async createMedia(mediaData: any, authorization?: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/api/media`, mediaData, this.authOptions(authorization))
      );
      return response.data.data;
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.warn(`Failed to create product media reference: ${errorMessage}`, 'CatalogClient');
      if (errorStack) this.logger.warn(errorStack, 'CatalogClient');
      return null;
    }
  }

  /**
   * Get product pricing
   */
  async getProductPricing(productId: string): Promise<any> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/api/pricing/product/${productId}/current`)
      );
      return response.data.data;
    } catch (error: unknown) {
      // Was `return null` on any error. OffersService.syncFromCatalog treats
      // null as "no price" and writes `price: 0` straight onto a live ad in an
      // unattended batch job — an auth or transport failure must not silently
      // zero out product pricing. Only a 404 means "no pricing record".
      if ((error as any)?.response?.status === HttpStatus.NOT_FOUND) {
        this.logger.warn(`Pricing not found for product ${productId}`, 'CatalogClient');
        return null;
      }
      this.rethrowCatalogLookupFailure(error, `productId=${productId}`, 'Pricing lookup');
    }
  }

  /**
   * Get product media
   */
  async getProductMedia(productId: string): Promise<any[]> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/api/media/product/${productId}`, this.authOptions())
      );
      return response.data.data || [];
    } catch (error: unknown) {
      // Was `return []` on any error. An auth or transport failure must not be
      // indistinguishable from a product genuinely having no media. Only a 404
      // means "no media for this product".
      if ((error as any)?.response?.status === HttpStatus.NOT_FOUND) {
        this.logger.warn(`Media not found for product ${productId}`, 'CatalogClient');
        return [];
      }
      this.rethrowCatalogLookupFailure(error, `productId=${productId}`, 'Media lookup');
    }
  }

  private authOptions(authorization?: string) {
    const headers: Record<string, string> = {};

    // A caller-supplied user token wins: routes like /api/catalog/access/provision
    // resolve per-user settings and reject a service principal outright
    // (CatalogAccessService.requireHumanUser -> 403), so the human identity must
    // not be replaced by the service one.
    if (authorization) {
      headers.Authorization = authorization;
      return { headers };
    }

    // Otherwise this is a service-to-service call and uses the per-pair
    // principal for bazos-service -> catalog-microservice. No fallback to the
    // former CATALOG_INTERNAL_SERVICE_TOKEN / INTERNAL_SERVICE_TOKEN: that was
    // one shared static secret held by seven services, paired with a
    // self-asserted x-service-name header -- the shape
    // SERVICE_IDENTITY_CONSUMER_STANDARD.md prohibits. Falling back to it would
    // silently restore the prohibited path, and because catalog still accepts it
    // the regression would authenticate successfully and be invisible.
    const serviceToken = process.env.CATALOG_SERVICE_TOKEN;
    if (serviceToken) {
      headers.Authorization = `Bearer ${serviceToken}`;
    }

    return Object.keys(headers).length ? { headers } : undefined;
  }
}

