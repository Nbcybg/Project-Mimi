using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Mimi.Core.ViewModels;
using VirtualKey = Windows.System.VirtualKey;

namespace Mimi.App.Views;

public sealed partial class SearchView : UserControl
{
    private readonly DispatcherQueueTimer typing;

    public SearchView(SearchViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
        // Searches a moment after typing stops, like the web (220 ms).
        typing = DispatcherQueue.GetForCurrentThread().CreateTimer();
        typing.Interval = TimeSpan.FromMilliseconds(220);
        typing.IsRepeating = false;
        typing.Tick += (_, _) => ViewModel.Run();
    }

    public SearchViewModel ViewModel { get; }

    public void FocusField()
    {
        Field.Focus(FocusState.Programmatic);
        Field.SelectAll();
    }

    private void OnTextChanged(object sender, TextChangedEventArgs e)
    {
        typing.Stop();
        typing.Start();
    }

    private void OnKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != VirtualKey.Enter) return;
        typing.Stop();
        ViewModel.Run();
        e.Handled = true;
    }

    private void OnHitClick(object sender, ItemClickEventArgs e)
    {
        if (e.ClickedItem is SearchRow row) ViewModel.Open(row);
    }
}
