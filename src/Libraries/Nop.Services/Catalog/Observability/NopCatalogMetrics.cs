using System.Diagnostics.Metrics;

namespace Nop.Services.Catalog.Observability;

/// <summary>
/// Declares all OpenTelemetry <see cref="Meter"/> instruments for the Catalog domain.
///
/// Same vendor-neutral principle as <see cref="NopCatalogActivitySource"/>:
/// only System.Diagnostics.Metrics (built-in .NET) is used here.
/// The OTel SDK MeterProvider is registered exclusively in the host (Nop.Web).
/// </summary>
public static class NopCatalogMetrics
{
    // ----------------------------------------------------------------------------
    // Meter identity
    // ----------------------------------------------------------------------------
    public const string MeterName = "Nop.Catalog";
    public const string MeterVersion = "1.0.0";

    private static readonly Meter _meter = new(MeterName, MeterVersion);

    // ----------------------------------------------------------------------------
    // Counters
    // ----------------------------------------------------------------------------

    /// <summary>Total number of catalogue products created (regardless of published state).</summary>
    public static readonly Counter<long> ProductsInserted =
        _meter.CreateCounter<long>(
            name: "catalog.products.inserted",
            unit: "{products}",
            description: "Total number of products inserted into the catalogue");

    /// <summary>Total number of catalogue product records updated.</summary>
    public static readonly Counter<long> ProductsUpdated =
        _meter.CreateCounter<long>(
            name: "catalog.products.updated",
            unit: "{products}",
            description: "Total number of product update operations performed");

    /// <summary>Number of times a product was transitioned to Published=true (first publish or re-publish).</summary>
    public static readonly Counter<long> ProductsPublished =
        _meter.CreateCounter<long>(
            name: "catalog.products.published",
            unit: "{products}",
            description: "Number of product publish events (Published flag set to true)");

    /// <summary>Number of times a product was transitioned to Published=false.</summary>
    public static readonly Counter<long> ProductsUnpublished =
        _meter.CreateCounter<long>(
            name: "catalog.products.unpublished",
            unit: "{products}",
            description: "Number of product unpublish events (Published flag set to false)");

    /// <summary>Number of cache invalidation operations triggered by catalogue entity events.</summary>
    public static readonly Counter<long> CacheInvalidations =
        _meter.CreateCounter<long>(
            name: "catalog.cache.invalidations",
            unit: "{operations}",
            description: "Number of cache invalidation operations triggered by product entity events");

    // ----------------------------------------------------------------------------
    // Histograms
    // ----------------------------------------------------------------------------

    /// <summary>
    /// End-to-end duration of the complete product-publish pipeline:
    /// service layer insert/update + triggered cache clearing.
    /// Measured at the service layer in milliseconds.
    /// </summary>
    public static readonly Histogram<double> ProductPublishDuration =
        _meter.CreateHistogram<double>(
            name: "catalog.product.publish.duration",
            unit: "ms",
            description: "End-to-end duration of the product publish pipeline (service + cache invalidation)");

    // ----------------------------------------------------------------------------
    // Exposed for OTel SDK MeterProvider registration
    // ----------------------------------------------------------------------------
    public static Meter Meter => _meter;
}
