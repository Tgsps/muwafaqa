using System;
using Microsoft.Xrm.Sdk;
using Microsoft.Xrm.Sdk.Query;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Logical names of the counter table mwf_contractnumbercounter (ADR-006).</summary>
    internal static class CounterColumns
    {
        public const string EntityName = "mwf_contractnumbercounter";
        public const string TypeValue = "mwf_contracttypevalue";   // Whole Number, alternate key
        public const string Prefix = "mwf_prefix";                 // text
        public const string LastNumber = "mwf_lastnumber";         // Whole Number
        public const string LockStamp = "mwf_lockstamp";           // text, a new value on every pre-lock write
    }

    /// <summary>
    /// Generates the contract number on Create (ADR-006). Registered on Create of mwf_contract, PreOperation (20), synchronous,
    /// with a rank after plug-in 1 so the counter lock is taken as late as possible (the lock is held until the transaction ends).
    ///
    /// The counter row is updated under the SYSTEM user (CreateOrganizationService(null)), so no user needs a privilege on the table.
    /// The Contract Type is required and a client-supplied number is rejected by the guard at PreValidation; this plug-in
    /// does NOT cancel in those cases. If the Target already holds a number (only possible when the guard step is bypassed on
    /// purpose) or has no type, it does nothing. It throws only for a counter problem (no counter row, empty prefix, overflow).
    /// </summary>
    public class GenerateContractNumberOnCreate : PluginBase
    {
        private const int PreOperationStage = 20;
        private const int SynchronousMode = 0;

        public GenerateContractNumberOnCreate(string unsecureConfiguration, string secureConfiguration)
            : base(typeof(GenerateContractNumberOnCreate))
        {
        }

        protected override void ExecuteDataversePlugin(ILocalPluginContext localPluginContext)
        {
            if (localPluginContext == null)
            {
                throw new ArgumentNullException(nameof(localPluginContext));
            }

            var context = localPluginContext.PluginExecutionContext;
            var trace = localPluginContext.TracingService;

            if (!string.Equals(context.PrimaryEntityName, ContractColumns.EntityName, StringComparison.Ordinal)
                || !string.Equals(context.MessageName, "Create", StringComparison.Ordinal))
            {
                return;
            }
            if (context.Stage != PreOperationStage || context.Mode != SynchronousMode)
            {
                // The number must be written to the Target inside the transaction, in a synchronous PreOperation step.
                throw new InvalidPluginExecutionException(
                    "GenerateContractNumberOnCreate must be registered as a synchronous PreOperation step.");
            }

            var target = context.InputParameters.Contains("Target") ? context.InputParameters["Target"] as Entity : null;
            if (target == null)
            {
                return;
            }

            var existing = target.GetAttributeValue<string>(ContractColumns.Number);
            if (!string.IsNullOrEmpty(existing))
            {
                trace.Trace("The Target already holds a contract number (the guard step was bypassed). Nothing to do.");
                return;
            }

            var type = target.GetAttributeValue<OptionSetValue>(ContractColumns.Type);
            if (type == null)
            {
                trace.Trace("The Target has no contract type (the guard rejects this at PreValidation). Nothing to do.");
                return;
            }

            try
            {
                // System user (null): the counter table has no user privileges (ADR-006).
                var service = localPluginContext.OrgSvcFactory.CreateOrganizationService(null);
                var number = ContractNumberGenerator.Allocate(
                    new DataverseCounterStore(service), type.Value, () => Guid.NewGuid().ToString("N"));
                target[ContractColumns.Number] = number;
                trace.Trace("Contract number generated for type value " + type.Value + ".");
            }
            catch (ContractNumberException ex)
            {
                trace.Trace("Contract number not generated: " + ex.Message);
                throw new InvalidPluginExecutionException("Cannot create the contract. " + ex.Message, ex);
            }
        }

        private sealed class DataverseCounterStore : ICounterStore
        {
            private readonly IOrganizationService _service;

            public DataverseCounterStore(IOrganizationService service)
            {
                _service = service;
            }

            public Guid? FindCounterId(int contractTypeValue)
            {
                var query = new QueryExpression(CounterColumns.EntityName)
                {
                    ColumnSet = new ColumnSet(false),     // the id only: no counter value is read before the lock
                    TopCount = 2
                };
                query.Criteria.AddCondition(CounterColumns.TypeValue, ConditionOperator.Equal, contractTypeValue);
                var rows = _service.RetrieveMultiple(query).Entities;
                if (rows.Count == 0) return null;
                if (rows.Count > 1)
                {
                    throw new ContractNumberException(
                        "More than one contract number counter exists for contract type value " + contractTypeValue + ".");
                }
                return rows[0].Id;
            }

            public void Lock(Guid counterId, string stamp)
            {
                var row = new Entity(CounterColumns.EntityName, counterId);
                row[CounterColumns.LockStamp] = stamp;
                _service.Update(row);
            }

            public CounterState ReadFresh(Guid counterId)
            {
                var row = _service.Retrieve(CounterColumns.EntityName, counterId,
                    new ColumnSet(CounterColumns.Prefix, CounterColumns.LastNumber));
                return new CounterState(
                    row.GetAttributeValue<string>(CounterColumns.Prefix),
                    row.GetAttributeValue<int?>(CounterColumns.LastNumber));
            }

            public void Write(Guid counterId, int lastNumber)
            {
                var row = new Entity(CounterColumns.EntityName, counterId);
                row[CounterColumns.LastNumber] = lastNumber;
                _service.Update(row);
            }
        }
    }
}
