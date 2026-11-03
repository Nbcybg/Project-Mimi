using System.ComponentModel;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Mimi.Core.ViewModels;
using Windows.System;

namespace Mimi.App.Views;

public sealed partial class ConnectView : UserControl, INotifyPropertyChanged
{
    public ConnectView(ConnectViewModel viewModel)
    {
        ViewModel = viewModel;
        InitializeComponent();
        viewModel.PropertyChanged += (_, args) =>
        {
            if (args.PropertyName == nameof(ConnectViewModel.Step)) PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(SignInVisible)));
        };
    }

    public ConnectViewModel ViewModel { get; }

    public bool SignInVisible => !ViewModel.OnServer;

    public event PropertyChangedEventHandler? PropertyChanged;

    private void OnServerKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && ViewModel.Idle) _ = ViewModel.Check();
    }

    private void OnSignInKey(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key == VirtualKey.Enter && ViewModel.Idle) _ = ViewModel.SignIn();
    }
}
