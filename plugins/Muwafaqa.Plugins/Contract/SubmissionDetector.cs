namespace Muwafaqa.Plugins.Contract
{
    /// <summary>Pure decision: does this operation make the contract ENTER Pending Approval?</summary>
    public static class SubmissionDetector
    {
        public const int PendingApproval = 867640000;

        /// <param name="messageName">"Create" or "Update".</param>
        /// <param name="targetStatus">Status Reason in the Target, null if the Target does not contain it.</param>
        /// <param name="preImageStatus">Status Reason before the operation (Update only), null if unknown.</param>
        public static bool EntersPendingApproval(string messageName, int? targetStatus, int? preImageStatus)
        {
            if (targetStatus != PendingApproval)
            {
                return false;
            }
            if (messageName == "Create")
            {
                return true;
            }
            if (messageName == "Update")
            {
                // A save that keeps the status at Pending Approval is not an entry.
                return preImageStatus != PendingApproval;
            }
            return false;
        }
    }
}
