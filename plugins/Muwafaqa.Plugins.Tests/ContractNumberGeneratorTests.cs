using System;
using System.Collections.Generic;
using Muwafaqa.Plugins.Contract;
using Xunit;

namespace Muwafaqa.Plugins.Tests
{
    public class ContractNumberGeneratorTests
    {
        /// <summary>An in-memory counter table. Records the order of the calls and the stamps written by the pre-lock.</summary>
        private sealed class FakeStore : ICounterStore
        {
            public readonly Dictionary<int, Guid> Ids = new Dictionary<int, Guid>();
            public readonly Dictionary<Guid, string> Prefix = new Dictionary<Guid, string>();
            public readonly Dictionary<Guid, int?> Last = new Dictionary<Guid, int?>();
            public readonly List<string> Calls = new List<string>();
            public readonly List<string> Stamps = new List<string>();
            public string StoredStamp;
            public Action BeforeRead;          // simulates another transaction that committed between the id lookup and the read

            public FakeStore Seed(int type, string prefix, int? last)
            {
                var id = Guid.NewGuid();
                Ids[type] = id; Prefix[id] = prefix; Last[id] = last;
                return this;
            }

            public Guid? FindCounterId(int contractTypeValue)
            {
                Calls.Add("find");
                Guid id;
                return Ids.TryGetValue(contractTypeValue, out id) ? id : (Guid?)null;
            }

            public void Lock(Guid counterId, string stamp)
            {
                Calls.Add("lock");
                Stamps.Add(stamp);
                if (stamp == StoredStamp) throw new InvalidOperationException("the lock write must change a value");
                StoredStamp = stamp;
            }

            public CounterState ReadFresh(Guid counterId)
            {
                Calls.Add("read");
                if (BeforeRead != null) { var a = BeforeRead; BeforeRead = null; a(); }
                return new CounterState(Prefix[counterId], Last[counterId]);
            }

            public void Write(Guid counterId, int lastNumber)
            {
                Calls.Add("write");
                Last[counterId] = lastNumber;
            }
        }

        private static Func<string> Stamps() { return () => Guid.NewGuid().ToString("N"); }

        [Fact]
        public void Allocates_in_the_order_find_lock_read_write()
        {
            var s = new FakeStore().Seed(1, "MNT", 0);
            Allocate(s, 1);
            Assert.Equal(new[] { "find", "lock", "read", "write" }, s.Calls);
        }

        private static string Allocate(FakeStore s, int type) { return ContractNumberGenerator.Allocate(s, type, Stamps()); }

        [Fact]
        public void First_number_is_0001_and_numbers_are_consecutive()
        {
            var s = new FakeStore().Seed(1, "MNT", 0);
            Assert.Equal("MNT-0001", Allocate(s, 1));
            Assert.Equal("MNT-0002", Allocate(s, 1));
            Assert.Equal("MNT-0003", Allocate(s, 1));
        }

        [Fact]
        public void A_null_last_number_is_an_error_because_the_column_is_required()
        {
            var s = new FakeStore().Seed(1, "MNT", null);
            Assert.Throws<ContractNumberException>(() => Allocate(s, 1));
            Assert.DoesNotContain("write", s.Calls);
        }

        [Fact]
        public void Types_have_independent_counters()
        {
            var s = new FakeStore().Seed(1, "MNT", 0).Seed(2, "PRC", 0);
            Assert.Equal("MNT-0001", Allocate(s, 1));
            Assert.Equal("PRC-0001", Allocate(s, 2));
            Assert.Equal("MNT-0002", Allocate(s, 1));
            Assert.Equal("PRC-0002", Allocate(s, 2));
        }

        [Fact]
        public void The_lock_stamp_is_new_every_time_and_never_the_stored_value()
        {
            var s = new FakeStore().Seed(1, "MNT", 0);
            for (var i = 0; i < 5; i++) Allocate(s, 1);
            Assert.Equal(5, s.Stamps.Count);
            Assert.Equal(5, new HashSet<string>(s.Stamps).Count);   // all different; FakeStore also throws on an identical write
        }

        [Fact]
        public void The_counter_is_read_after_the_lock_not_before()
        {
            // another transaction commits 41 -> 42 after our id lookup but before our read; we must see 42 and issue 43
            var s = new FakeStore().Seed(1, "MNT", 41);
            var id = s.Ids[1];
            s.BeforeRead = () => s.Last[id] = 42;
            Assert.Equal("MNT-0043", Allocate(s, 1));
            Assert.Equal(43, s.Last[id]);
        }

        [Fact]
        public void A_missing_counter_row_throws_and_writes_nothing()
        {
            var s = new FakeStore();
            var ex = Assert.Throws<ContractNumberException>(() => Allocate(s, 7));
            Assert.Contains("seeded", ex.Message);
            Assert.Equal(new[] { "find" }, s.Calls);
        }

        [Theory]
        [InlineData(null)]
        [InlineData("")]
        [InlineData("   ")]
        [InlineData("MN/T")]
        [InlineData("MN T")]
        [InlineData("MN+T")]
        public void A_bad_prefix_throws_before_anything_is_written(string prefix)
        {
            var s = new FakeStore().Seed(1, prefix, 5);
            Assert.Throws<ContractNumberException>(() => Allocate(s, 1));
            Assert.DoesNotContain("write", s.Calls);
            Assert.Equal(5, s.Last[s.Ids[1]]);
        }

        [Fact]
        public void A_negative_last_number_and_an_overflow_throw()
        {
            var neg = new FakeStore().Seed(1, "MNT", -3);
            Assert.Throws<ContractNumberException>(() => Allocate(neg, 1));
            var max = new FakeStore().Seed(1, "MNT", int.MaxValue);
            Assert.Throws<ContractNumberException>(() => Allocate(max, 1));
            Assert.DoesNotContain("write", max.Calls);
        }

        [Fact]
        public void An_empty_stamp_is_rejected_before_the_lock()
        {
            var s = new FakeStore().Seed(1, "MNT", 0);
            Assert.Throws<ContractNumberException>(() => ContractNumberGenerator.Allocate(s, 1, () => string.Empty));
            Assert.DoesNotContain("lock", s.Calls);
        }

        // ---- format ----
        [Theory]
        [InlineData("MNT", 1, "MNT-0001")]
        [InlineData("PRC", 42, "PRC-0042")]
        [InlineData("INS", 999, "INS-0999")]
        [InlineData("SAL", 9999, "SAL-9999")]
        [InlineData("SRV", 10000, "SRV-10000")]
        [InlineData("MNT", 123456, "MNT-123456")]
        public void Format_has_at_least_four_digits_and_grows(string prefix, int n, string expected)
        {
            Assert.Equal(expected, ContractNumberFormat.Format(prefix, n));
        }

        [Theory]
        [InlineData(0)]
        [InlineData(-1)]
        public void Format_rejects_a_number_below_one(int n)
        {
            Assert.Throws<ContractNumberException>(() => ContractNumberFormat.Format("MNT", n));
        }

        [Fact]
        public void A_formatted_number_never_contains_a_restricted_character()
        {
            var number = ContractNumberFormat.Format("MNT", 7);
            foreach (var c in "/<>*%&:\\?+") Assert.DoesNotContain(c.ToString(), number);
        }
    }
}
