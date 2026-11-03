using Microsoft.UI.Xaml.Controls;
using Mimi.Core.ViewModels;

namespace Mimi.App.Views;

public sealed partial class InboxView : UserControl
{
    public InboxView(InboxViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
    }

    public InboxViewModel ViewModel { get; }

    public static double Dim(bool unread) => unread ? 1 : 0.7;

    private void OnItemClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is InboxRow row) ViewModel.Open(row);
    }
}
