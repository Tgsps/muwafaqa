namespace Muwafaqa.Plugins.Contract
{
    /// <summary>A contract may be deleted in Draft or Rejected. Pending Approval and In Force cannot be deleted.</summary>
    public static class DeletePolicy
    {
        public static PolicyResult Check(int currentStatus)
        {
            if (currentStatus == ContractStatus.Draft || currentStatus == ContractStatus.Rejected)
            {
                return PolicyResult.Allow;
            }
            return PolicyResult.Deny("Cannot delete a contract whose status is " + ContractStatus.NameOf(currentStatus) + ".");
        }
    }
}
