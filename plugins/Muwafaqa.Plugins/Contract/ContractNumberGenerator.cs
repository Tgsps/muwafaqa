using System;
using System.Globalization;

namespace Muwafaqa.Plugins.Contract
{
    /// <summary>The counter of one contract type, as read AFTER the pre-lock.</summary>
    public sealed class CounterState
    {
        public string Prefix { get; }
        public int? LastNumber { get; }

        public CounterState(string prefix, int? lastNumber)
        {
            Prefix = prefix; LastNumber = lastNumber;
        }
    }

    /// <summary>A counter problem (missing row, bad prefix, overflow). The plug-in shell turns it into a user-facing error.</summary>
    public sealed class ContractNumberException : Exception
    {
        public ContractNumberException(string message) : base(message) { }
    }

    /// <summary>
    /// What the generator needs from the counter table. The Dataverse implementation is in GenerateContractNumberOnCreate;
    /// tests use a fake. No Dataverse types here.
    /// </summary>
    public interface ICounterStore
    {
        /// <summary>The id of the counter row of the type, or null. Returns the id ONLY: no counter value is read here.</summary>
        Guid? FindCounterId(int contractTypeValue);

        /// <summary>The placeholder update that takes the exclusive row lock. It MUST write a value that differs from the stored one.</summary>
        void Lock(Guid counterId, string stamp);

        /// <summary>A fresh read of the counter row. Called after Lock only.</summary>
        CounterState ReadFresh(Guid counterId);

        /// <summary>Stores the issued number as the last number.</summary>
        void Write(Guid counterId, int lastNumber);
    }

    /// <summary>"PREFIX-NNNN": the prefix, a hyphen, the number with at least 4 digits (it grows beyond 9999).</summary>
    public static class ContractNumberFormat
    {
        public const int MinDigits = 4;
        private const string Restricted = "/<>*%&:\\?+";   // ADR-002: break GET/PATCH by alternate key

        public static string Format(string prefix, int number)
        {
            if (string.IsNullOrWhiteSpace(prefix))
            {
                throw new ContractNumberException("The prefix of the contract number counter is empty.");
            }
            foreach (var c in prefix)
            {
                if (char.IsWhiteSpace(c) || Restricted.IndexOf(c) >= 0)
                {
                    throw new ContractNumberException("The prefix of the contract number counter contains a character that is not allowed.");
                }
            }
            if (number < 1)
            {
                throw new ContractNumberException("A contract number must be at least 1.");
            }
            return prefix + "-" + number.ToString("D" + MinDigits, CultureInfo.InvariantCulture);
        }
    }

    /// <summary>
    /// Approach 3 of the Microsoft Learn autonumbering example (pre-lock in a plug-in transaction), ADR-006:
    ///   1. find the counter row id (no value is read),
    ///   2. placeholder update that CHANGES a value (a fresh stamp every time): this takes the exclusive lock,
    ///   3. read the counter with a fresh query,
    ///   4. increment and write it back,
    ///   5. return the formatted number.
    /// Pure orchestration, so the order of the calls is unit tested.
    /// </summary>
    public static class ContractNumberGenerator
    {
        public static string Allocate(ICounterStore store, int contractTypeValue, Func<string> newStamp)
        {
            if (store == null) throw new ArgumentNullException(nameof(store));
            if (newStamp == null) throw new ArgumentNullException(nameof(newStamp));

            var id = store.FindCounterId(contractTypeValue);
            if (!id.HasValue)
            {
                throw new ContractNumberException(
                    "No contract number counter exists for contract type value " + contractTypeValue + ". The counter rows must be seeded.");
            }

            var stamp = newStamp();
            if (string.IsNullOrEmpty(stamp))
            {
                throw new ContractNumberException("The lock stamp is empty.");
            }
            store.Lock(id.Value, stamp);

            var state = store.ReadFresh(id.Value);
            if (state == null || !state.LastNumber.HasValue)
            {
                throw new ContractNumberException("The contract number counter has no last number.");
            }
            var last = state.LastNumber.Value;
            if (last < 0)
            {
                throw new ContractNumberException("The contract number counter holds a negative last number.");
            }
            if (last == int.MaxValue)
            {
                throw new ContractNumberException("The contract number counter reached its maximum.");
            }

            var next = last + 1;
            var number = ContractNumberFormat.Format(state.Prefix, next);   // validates the prefix before anything is written
            store.Write(id.Value, next);
            return number;
        }
    }
}
