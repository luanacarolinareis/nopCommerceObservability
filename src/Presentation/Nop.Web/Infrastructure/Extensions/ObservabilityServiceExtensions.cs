using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Nop.Services.Catalog.Observability;

namespace Nop.Web.Infrastructure.Extensions;

/// <summary>
/// Extension methods that wire the OpenTelemetry SDK to the DI container.
///
/// Design rationale:
///   – The SDK is registered ONLY here (composition-root principle).
///   – Instrumentation code in Nop.Services uses only System.Diagnostics
///     (ActivitySource / Meter), with zero OTel SDK dependency.
///   – The SDK discovers those sources/meters through its listener model.
/// </summary>
public static class ObservabilityServiceExtensions
{
    private const string ServiceName = "nopcommerce";
    private const string ServiceVersion = "5.0.0";

    /// <summary>
    /// Registers OpenTelemetry tracing and metrics with the service collection.
    /// Call this from <c>ConfigureApplicationServices</c> or <c>Program.cs</c>.
    /// </summary>
    public static IServiceCollection AddNopObservability(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        // Read the OTLP endpoint from config so it can be overridden via
        // environment variable or appsettings.json without recompiling
        var otlpEndpoint = configuration["Observability:OtlpEndpoint"] ?? "http://localhost:4317";

        var exportToConsole = bool.TryParse(configuration["Observability:ConsoleExporterEnabled"], out var c) && c;

        services
            .AddOpenTelemetry()
            .ConfigureResource(resource => resource
                .AddService(
                    serviceName: ServiceName,
                    serviceVersion: ServiceVersion)
                // Extra resource attributes following OTel semantic conventions
                .AddAttributes(new Dictionary<string, object>
                {
                    ["deployment.environment"] = Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") ?? "Production",
                }))
            // Traces
            .WithTracing(tracing =>
            {
                tracing
                    // Automatic: incoming HTTP requests via ASP.NET Core
                    .AddAspNetCoreInstrumentation(opts =>
                    {
                        // Only record spans that reach our admin area,
                        // keeping trace volume low in non-demo environments
                        opts.Filter = ctx =>
                            ctx.Request.Path.StartsWithSegments("/Admin") ||
                            ctx.Request.Path.StartsWithSegments("/api");
                        opts.RecordException = true;
                    })
                    // Automatic: outgoing HTTP calls (payment gateways, etc.)
                    .AddHttpClientInstrumentation()
                    // Manual: our catalog domain ActivitySource
                    .AddSource(NopCatalogActivitySource.SourceName)
                    // Exporters
                    .AddOtlpExporter(opts =>
                    {
                        opts.Endpoint = new Uri(otlpEndpoint);
                    });

                if (exportToConsole)
                    tracing.AddConsoleExporter();
            })
            // Metrics
            .WithMetrics(metrics =>
            {
                metrics
                    // Built-in ASP.NET Core metrics
                    .AddAspNetCoreInstrumentation()
                    // Our catalog domain Meter
                    .AddMeter(NopCatalogMetrics.MeterName)
                    // Prometheus endpoint at /metrics (for Grafana/Prometheus scraping)
                    .AddPrometheusExporter()
                    // Also push over OTLP so the Collector can relay to any backend
                    .AddOtlpExporter(opts =>
                    {
                        opts.Endpoint = new Uri(otlpEndpoint);
                    });

                if (exportToConsole)
                    metrics.AddConsoleExporter();
            });

        return services;
    }

    /// <summary>
    /// Maps the Prometheus scrape endpoint.
    /// Call this after <c>app.UseRouting()</c>.
    /// </summary>
    public static IApplicationBuilder UseNopObservability(this IApplicationBuilder app)
    {
        // Exposes GET /metrics in the Prometheus text format
        app.UseOpenTelemetryPrometheusScrapingEndpoint();
        return app;
    }
}
