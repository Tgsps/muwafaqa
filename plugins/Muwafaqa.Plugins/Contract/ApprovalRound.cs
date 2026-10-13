namespace Muwafaqa.Plugins.Contract
{
    /// <summary>
    /// The approval round of a contract: how many times it was really submitted (entered Pending Approval).
    /// A contract that was never submitted holds null (a Whole Number column has no default value), which counts as 0.
    /// Pure, so it is unit tested without an environment.
    /// </summary>
    public static class ApprovalRound
    {
        /// <summary>The round after one more submission: (current or 0) + 1. A negative stored value is treated as 0.</summary>
        public static int Next(int? current)
        {
            var c = current.GetValueOrDefault();
            if (c < 0) c = 0;
            return checked(c + 1);
        }
    }
}
