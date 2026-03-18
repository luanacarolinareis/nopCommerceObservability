using System.Diagnostics;
using Nop.Core.Caching;
using Nop.Core.Domain.Catalog;
using Nop.Core.Domain.Orders;
using Nop.Services.Caching;
using Nop.Services.Catalog.Observability;
using Nop.Services.Discounts;

namespace Nop.Services.Catalog.Caching;

/// <summary>
/// Represents a product cache event consumer
/// </summary>
public partial class ProductCacheEventConsumer : CacheEventConsumer<Product>
{
    /// <summary>
    /// Clear cache data
    /// </summary>
    /// <param name="entity">Entity</param>
    /// <param name="entityEventType">Entity event type</param>
    /// <returns>A task that represents the asynchronous operation</returns>
    protected override async Task ClearCacheAsync(Product entity, EntityEventType entityEventType)
    {
        // Observability: wrap the entire invalidation in a child span
        using var activity = NopCatalogActivitySource.StartCacheClearActivity(
            entityType: "Product",
            entityId:   entity.Id,
            eventType:  entityEventType.ToString());

        // Count how many logical removal operations are performed so the span has
        // measurable data even when the actual key enumeration is opaque
        var removalCount = 0;

        await RemoveByPrefixAsync(NopCatalogDefaults.ProductManufacturersByProductPrefix, entity); removalCount++;
        await RemoveAsync(NopCatalogDefaults.ProductsHomepageCacheKey); removalCount++;
        await RemoveByPrefixAsync(NopCatalogDefaults.ProductPricePrefix, entity); removalCount++;
        await RemoveByPrefixAsync(NopCatalogDefaults.ProductMultiplePricePrefix, entity); removalCount++;
        await RemoveByPrefixAsync(NopEntityCacheDefaults<ShoppingCartItem>.AllPrefix); removalCount++;
        await RemoveByPrefixAsync(NopCatalogDefaults.FeaturedProductIdsPrefix); removalCount++;

        if (entityEventType == EntityEventType.Delete)
        {
            await RemoveByPrefixAsync(NopCatalogDefaults.FilterableSpecificationAttributeOptionsPrefix); removalCount++;
            await RemoveByPrefixAsync(NopCatalogDefaults.ManufacturersByCategoryPrefix); removalCount++;
        }

        await RemoveAsync(NopDiscountDefaults.AppliedDiscountsCacheKey, nameof(Product), entity); removalCount++;

        // Enrich span with the aggregated count before delegating to base
        activity?.SetTag(NopCatalogActivitySource.CacheKeysRemovedTag, removalCount);
        activity?.SetStatus(ActivityStatusCode.Ok);

        // Metrics
        NopCatalogMetrics.CacheInvalidations.Add(removalCount, new KeyValuePair<string, object?>("entity_event_type", entityEventType.ToString()));

        await base.ClearCacheAsync(entity, entityEventType);
    }
}